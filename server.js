const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    pingInterval: 10000, // Invia heartbeat ogni 10s
    pingTimeout: 30000   // Considera persa la connessione dopo 30s
});

app.use(express.static(path.join(__dirname, 'public')));

let waitingQueue = { 'no-time': [], '10': [], '30': [] };
let games = {};

io.on('connection', (socket) => {
    // Gestione Ping custom (oltre a quello di socket.io)
    socket.on('ping', () => socket.emit('pong', Date.now()));

    // 1. Ricerca Partita
    socket.on('find_game', ({ username, timeControl }) => {
        // Se il giocatore era già in una partita "sospesa", gestiamo la riconnessione (Logica base)
        // Per ora implementiamo la ricerca standard
        const queue = waitingQueue[timeControl];
        
        if (queue.length > 0) {
            const opponent = queue.shift();
            const gameId = `game_${opponent.id}_${socket.id}`;
            const rand = Math.random();
            const p1Color = rand > 0.5 ? 'white' : 'black';
            const p2Color = p1Color === 'white' ? 'black' : 'white';

            games[gameId] = {
                id: gameId,
                p1: { id: opponent.id, socket: opponent.socket, color: p1Color, name: opponent.name, time: parseInt(timeControl)*60, undos: 3 },
                p2: { id: socket.id, socket: socket, color: p2Color, name: username, time: parseInt(timeControl)*60, undos: 3 },
                turn: 'black',
                startTime: Date.now(),
                lastMoveTime: Date.now(),
                moves: 0,
                timerInterval: null,
                disconnectTimeout: null // Timer per i 2 minuti
            };

            opponent.socket.join(gameId);
            socket.join(gameId);

            if (timeControl !== 'no-time') startServerTimer(gameId);

            io.to(gameId).emit('game_start', {
                gameId,
                white: p1Color === 'white' ? opponent.name : username,
                black: p1Color === 'black' ? opponent.name : username
            });

            io.to(opponent.id).emit('assign_color', p1Color);
            io.to(socket.id).emit('assign_color', p2Color);

        } else {
            queue.push({ id: socket.id, name: username, socket: socket });
        }
    });

    // 2. Mossa
    socket.on('make_move', (data) => {
        const game = games[data.gameId];
        if (!game) return;
        game.moves++;
        game.lastMoveTime = Date.now();
        game.turn = game.turn === 'white' ? 'black' : 'white';
        socket.to(data.gameId).emit('opponent_move', data.moveData);
    });

    // 3. Logica Annulla Mossa
    socket.on('request_undo', ({ gameId }) => {
        const game = games[gameId];
        if(!game) return;
        // Inoltra la richiesta all'avversario
        socket.to(gameId).emit('undo_requested');
    });

    socket.on('answer_undo', ({ gameId, answer }) => {
        const game = games[gameId];
        if(!game) return;

        if (answer === true) {
            // Riduciamo il contatore di chi ha chiesto (l'avversario di chi risponde)
            const requester = (socket.id === game.p1.id) ? game.p2 : game.p1;
            if(requester.undos > 0) {
                requester.undos--;
                // Torniamo indietro col turno nel server
                game.turn = game.turn === 'white' ? 'black' : 'white';
                game.moves--; 
                io.to(gameId).emit('undo_accepted', { 
                    newTurn: game.turn, 
                    whiteUndos: (game.p1.color === 'white' ? game.p1.undos : game.p2.undos),
                    blackUndos: (game.p1.color === 'black' ? game.p1.undos : game.p2.undos)
                });
            }
        } else {
            socket.to(gameId).emit('undo_refused');
        }
    });

    // 4. Abbandono / Annullamento
    socket.on('surrender_game', ({ gameId }) => {
        const game = games[gameId];
        if(game) {
            const winner = (socket.id === game.p1.id) ? game.p2.color : game.p1.color;
            // Se moves == 0 è annullamento, altrimenti è resa
            const reason = game.moves === 0 ? 'cancelled' : 'surrender';
            
            io.to(gameId).emit('game_over_forced', { winner, reason });
            closeGame(gameId);
        }
    });

    // 5. Gestione Disconnessione Robusta
    socket.on('disconnect', () => {
        // Rimuovi dalle code d'attesa
        for(let key in waitingQueue) {
            waitingQueue[key] = waitingQueue[key].filter(p => p.id !== socket.id);
        }

        // Cerca se era in partita
        for (let gId in games) {
            const g = games[gId];
            if (g.p1.id === socket.id || g.p2.id === socket.id) {
                
                const opponentSocket = (g.p1.id === socket.id) ? g.p2.socket : g.p1.socket;
                
                // Avvisiamo l'avversario che c'è un problema di connessione
                opponentSocket.emit('opponent_connection_lost');

                // AVVIO TIMER DI RECUPERO (2 Minuti)
                if (!g.disconnectTimeout) {
                    console.log(`Partita ${gId}: utente disconnesso. Attendo 2 minuti.`);
                    g.disconnectTimeout = setTimeout(() => {
                        // Tempo scaduto: Sconfitta
                        const winnerColor = (g.p1.id === socket.id) ? g.p2.color : g.p1.color;
                        io.to(gId).emit('game_over_timeout', { winner: winnerColor, reason: 'disconnection' });
                        closeGame(gId);
                    }, 120000); // 120.000 ms = 2 minuti
                }
            }
        }
    });
});

function startServerTimer(gameId) {
    const game = games[gameId];
    game.timerInterval = setInterval(() => {
        const now = Date.now();
        // Logica timeout inattività (5 min) se nessuno muove
        if (now - game.lastMoveTime > 300000) {
            io.to(gameId).emit('game_over_timeout', { reason: 'inactivity' });
            closeGame(gameId);
            return;
        }
        
        // Decremento tempo
        const activePlayer = game.turn === 'white' 
            ? (game.p1.color === 'white' ? game.p1 : game.p2)
            : (game.p1.color === 'black' ? game.p1 : game.p2);
        
        activePlayer.time--;
        if (activePlayer.time <= 0) {
            io.to(gameId).emit('time_expired', { loser: game.turn });
            closeGame(gameId);
        }
    }, 1000);
}

function closeGame(gameId) {
    if(games[gameId]) {
        clearInterval(games[gameId].timerInterval);
        clearTimeout(games[gameId].disconnectTimeout);
        delete games[gameId];
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server avviato su porta ${PORT}`));
