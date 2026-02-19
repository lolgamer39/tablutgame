const initialLayout = [
    [0, 0, 0, 3, 3, 3, 0, 0, 0],
    [0, 0, 0, 0, 3, 0, 0, 0, 0],
    [0, 0, 0, 0, 1, 0, 0, 0, 0],
    [3, 0, 0, 0, 1, 0, 0, 0, 3],
    [3, 3, 1, 1, 2, 1, 1, 3, 3],
    [3, 0, 0, 0, 1, 0, 0, 0, 3],
    [0, 0, 0, 0, 1, 0, 0, 0, 0],
    [0, 0, 0, 0, 3, 0, 0, 0, 0],
    [0, 0, 0, 3, 3, 3, 0, 0, 0]
];

let board = [];
let turn = 'black'; 
let selected = null;
let gameOver = false;
let historyHash = {}; 
let gameHistoryList = []; 
let moveLog = []; 
let mode = 'local';
let socket;
let myColor = null;
let gameId = null;
let playerId = null;
let timers = { white: 0, black: 0 };
let timerInterval = null;
let movesCount = 0; 
let undosLeft = 3;  
let currentHistoryIndex = 0;
let showHints = true;
let canUndoLocal = false; 

let audioSettings = { sfxOn: true, sfxVol: 0.6 };

const themes = {
    classic: { board: '#5a3a22', throne: '#ffd700', escape: '#86efac', hint: 'rgba(20, 100, 20, 0.6)' },
    ice: { board: '#1e3a8a', throne: '#60a5fa', escape: '#dbeafe', hint: 'rgba(0, 40, 100, 0.8)' },
    magma: { board: '#7f1d1d', throne: '#f97316', escape: '#fca5a5', hint: 'rgba(100, 20, 0, 0.8)' },
    forest: { board: '#14532d', throne: '#84cc16', escape: '#4ade80', hint: 'rgba(10, 50, 10, 0.9)' },
    cyber: { board: '#2e1065', throne: '#d946ef', escape: '#22d3ee', hint: 'rgba(80, 0, 120, 0.9)' }
};

document.addEventListener('DOMContentLoaded', () => {
    loadSettings();
    
    playerId = localStorage.getItem('tablut_player_id');
    if (!playerId) {
        playerId = 'player_' + Math.random().toString(36).substr(2, 9);
        localStorage.setItem('tablut_player_id', playerId);
    }

    const savedState = localStorage.getItem('tablut_active_game');
    const params = new URLSearchParams(window.location.search);
    const requestedMode = params.get('mode') || 'local';
    
    // CONTROLLO DI SICUREZZA ANTI-GHOST SAVE
    let validSave = false;
    if (savedState && !params.get('forceNew')) {
        try {
            const parsedState = JSON.parse(savedState);
            // Il salvataggio è valido SOLO se corrisponde alla modalità richiesta nell'URL
            if (parsedState.mode === requestedMode) {
                validSave = true;
            } else {
                localStorage.removeItem('tablut_active_game'); // Cestina salvataggio sbagliato
            }
        } catch(e) {}
    }

    if (validSave) {
        restoreGameState(savedState);
    } else {
        // Avvia una partita pulita
        mode = requestedMode;
        const name = params.get('name') || 'Giocatore';
        const time = params.get('time') || 'no-time';
        
        storedParams = { name, time };

        if (mode === 'online') {
            initOnline(name, time);
        } else {
            startGame();
        }
    }
    
    const btnPrev = document.getElementById('btn-prev');
    const btnNext = document.getElementById('btn-next');
    if(btnPrev) btnPrev.addEventListener('click', () => navigateHistory(-1));
    if(btnNext) btnNext.addEventListener('click', () => navigateHistory(1));

    document.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowLeft') navigateHistory(-1);
        if (e.key === 'ArrowRight') navigateHistory(1);
    });

    const playAgainBtn = document.getElementById('play-again-btn');
    if(playAgainBtn) {
        playAgainBtn.onclick = () => {
            const name = document.getElementById('my-name') ? document.getElementById('my-name').innerText : 'Giocatore';
            const time = storedParams.time || 'no-time';
            window.location.href = `game.html?mode=${mode}&name=${encodeURIComponent(name)}&time=${time}&forceNew=true`;
        };
    }
});

// --- SALVATAGGIO STATO ---
function saveGameState() {
    if (gameOver) return; 
    const state = {
        board, turn, gameHistoryList, moveLog, movesCount, 
        mode, gameId, myColor, timers, undosLeft, canUndoLocal,
        oppName: document.getElementById('opp-name') ? document.getElementById('opp-name').innerText : '',
        myName: document.getElementById('my-name') ? document.getElementById('my-name').innerText : '',
        storedParams
    };
    localStorage.setItem('tablut_active_game', JSON.stringify(state));
}

function restoreGameState(savedData) {
    const state = JSON.parse(savedData);
    board = state.board;
    turn = state.turn;
    gameHistoryList = state.gameHistoryList;
    moveLog = state.moveLog;
    movesCount = state.movesCount;
    mode = state.mode;
    gameId = state.gameId;
    myColor = state.myColor;
    timers = state.timers;
    undosLeft = state.undosLeft;
    canUndoLocal = state.canUndoLocal || false;
    storedParams = state.storedParams || { time: 'no-time' };
    currentHistoryIndex = gameHistoryList.length - 1;
    
    if (mode === 'online') {
        document.getElementById('opp-name').innerText = state.oppName;
        document.getElementById('my-name').innerText = state.myName;
        const myDot = document.getElementById('my-color');
        const oppDot = document.getElementById('opp-color');
        if (myColor === 'white') { myDot.classList.add('is-white'); oppDot.classList.add('is-black'); } 
        else { myDot.classList.add('is-black'); oppDot.classList.add('is-white'); }
        
        reconnectOnline();
    } else {
        updateUI(); updateButtonsUI(); updateMoveTable(); updateNavUI(); drawBoard();
    }
}

function exitGameAndClear() {
    localStorage.removeItem('tablut_active_game');
    if (mode === 'online' && socket && !gameOver) {
        socket.emit('surrender_game', { gameId });
    }
    window.location.href = '../index.html';
}

// --- GESTIONE NUOVI MODALI DI CONFERMA ---

function closeConfirmModals() {
    document.getElementById('confirm-surrender-modal').classList.add('hidden');
    document.getElementById('confirm-undo-modal').classList.add('hidden');
    document.getElementById('confirm-restart-modal').classList.add('hidden');
}

// 1. Riavvia
function restartLocalGame() {
    document.getElementById('confirm-restart-modal').classList.remove('hidden');
}
function executeRestart() {
    closeConfirmModals();
    localStorage.removeItem('tablut_active_game');
    startGame();
}

// 2. Abbandona / Annulla
function handleSurrender() {
    if (mode === 'local') return;
    
    const isAnnulla = movesCount < 2;
    document.getElementById('confirm-surrender-title').innerText = isAnnulla ? "Annulla Partita" : "Abbandona";
    document.getElementById('confirm-surrender-desc').innerText = isAnnulla ? 
        "Sei sicuro di voler annullare la partita? Non hai ancora mosso." : 
        "Sei sicuro di voler abbandonare e dichiarare la sconfitta?";
    
    document.getElementById('confirm-surrender-modal').classList.remove('hidden');
}
function executeSurrender() {
    closeConfirmModals();
    localStorage.removeItem('tablut_active_game');
    socket.emit('surrender_game', { gameId });
}

// 3. Annulla Mossa
function requestUndo() {
    if (mode === 'local') {
        if (canUndoLocal && movesCount > 0) {
            document.getElementById('confirm-undo-desc').innerText = "Vuoi annullare l'ultima mossa?";
            document.getElementById('confirm-undo-modal').classList.remove('hidden');
        }
    } else {
        if(undosLeft > 0 && turn !== myColor) { 
            document.getElementById('confirm-undo-desc').innerText = `Vuoi richiedere di annullare la mossa all'avversario?\n(Hai ancora ${undosLeft} tentativi)`;
            document.getElementById('confirm-undo-modal').classList.remove('hidden');
        } else if (undosLeft <= 0) alert("Tentativi esauriti.");
        else alert("Non è il tuo turno per annullare.");
    }
}
function executeUndo() {
    closeConfirmModals();
    if (mode === 'local') {
        gameHistoryList.pop(); 
        moveLog.pop();
        const prevState = gameHistoryList[gameHistoryList.length - 1];
        board = JSON.parse(prevState);
        turn = turn === 'white' ? 'black' : 'white'; 
        movesCount--; 
        currentHistoryIndex = gameHistoryList.length - 1;
        canUndoLocal = false; 
        saveGameState();
        drawBoard(); updateUI(); updateButtonsUI(); updateMoveTable(); updateNavUI();
    } else {
        socket.emit('request_undo', { gameId });
    }
}

// ----------------------------------------

function loadSettings() {
    const savedSfx = localStorage.getItem('tablut_sfx_on'), savedSfxVol = localStorage.getItem('tablut_sfx_vol');
    if(savedSfx !== null) audioSettings.sfxOn = (savedSfx === 'true');
    if(savedSfxVol !== null) audioSettings.sfxVol = parseFloat(savedSfxVol);
    const st = document.getElementById('sfx-toggle'), sv = document.getElementById('sfx-vol');
    if(st) st.checked = audioSettings.sfxOn; if(sv) sv.value = audioSettings.sfxVol;

    const savedTheme = localStorage.getItem('tablut_theme') || 'classic';
    const sel = document.getElementById('theme-selector');
    if(sel) sel.value = savedTheme;
    applyTheme(savedTheme);
}
function updateAudioSettings() {
    audioSettings.sfxOn = document.getElementById('sfx-toggle').checked;
    audioSettings.sfxVol = document.getElementById('sfx-vol').value;
    localStorage.setItem('tablut_sfx_on', audioSettings.sfxOn);
    localStorage.setItem('tablut_sfx_vol', audioSettings.sfxVol);
}
function applyTheme(themeName) {
    const t = themes[themeName] || themes['classic'];
    document.documentElement.style.setProperty('--board-bg', t.board);
    document.documentElement.style.setProperty('--throne-bg', t.throne);
    document.documentElement.style.setProperty('--escape-bg', t.escape);
    document.documentElement.style.setProperty('--hint-color', t.hint);
    localStorage.setItem('tablut_theme', themeName);
}
function playMoveSound() { if (audioSettings.sfxOn) { const sound = document.getElementById('move-sound'); if(sound) { sound.currentTime = 0; sound.volume = audioSettings.sfxVol; sound.play().catch(()=>{}); } } }
function playWinSound() { if (audioSettings.sfxOn) { const sound = document.getElementById('win-sound'); if(sound) { sound.currentTime = 0; sound.volume = 1.0; sound.play().catch(()=>{}); } } }

// --- LOGICA GIOCO ---
function toggleSettingsModal() { document.getElementById('settings-modal').classList.toggle('hidden'); }
function toggleHints() { showHints = document.getElementById('hints-toggle').checked; drawBoard(); }

function startGame() {
    board = JSON.parse(JSON.stringify(initialLayout));
    turn = 'black'; gameOver = false; selected = null; historyHash = {}; 
    gameHistoryList = [JSON.stringify(board)]; moveLog = []; movesCount = 0; undosLeft = 3; currentHistoryIndex = 0;
    canUndoLocal = false;
    saveGameState();
    drawBoard(); updateUI(); updateButtonsUI(); updateMoveTable(); updateNavUI();
}

function drawBoard() {
    const el = document.getElementById('board'); el.innerHTML = '';
    let stateToDraw = board;
    if (gameHistoryList.length > 0) stateToDraw = JSON.parse(gameHistoryList[currentHistoryIndex]);
    const isLive = (currentHistoryIndex === gameHistoryList.length - 1);
    let moves = [];
    if (isLive && selected && !gameOver && showHints) moves = getMoves(selected.r, selected.c);

    for(let r=0; r<9; r++) {
        for(let c=0; c<9; c++) {
            const cell = document.createElement('div'); cell.className = 'cell';
            if(r===4 && c===4) cell.classList.add('throne');
            if((r===0||r===8) && (c===0||c===8)) cell.classList.add('escape');
            if (r === 8) { const s = document.createElement('span'); s.className = 'coord coord-letter'; s.innerText = String.fromCharCode(97 + c); cell.appendChild(s); }
            if (c === 0) { const s = document.createElement('span'); s.className = 'coord coord-num'; s.innerText = 9 - r; cell.appendChild(s); }
            if (isLive) cell.onclick = () => handleClick(r, c); else cell.style.cursor = 'default';
            if(isLive && selected && selected.r === r && selected.c === c) cell.classList.add('selected');
            if(isLive && showHints && moves.some(m => m.r===r && m.c===c)) { const h = document.createElement('div'); h.className='hint'; cell.appendChild(h); }
            const val = stateToDraw[r][c];
            if(val !== 0) {
                const p = document.createElement('div'); p.className = 'piece ' + (val===3 ? 'black-piece' : 'white-piece');
                if(val===2) p.classList.add('king'); cell.appendChild(p);
            }
            el.appendChild(cell);
        }
    }
}

function handleClick(r, c) {
    if (gameOver) return;
    if (mode === 'online' && turn !== myColor) return; 
    const val = board[r][c];
    if (isMyPiece(val)) { selected = {r, c}; drawBoard(); return; }
    if (selected && val === 0) {
        const moves = getMoves(selected.r, selected.c);
        if (moves.some(m => m.r === r && m.c === c)) makeMove(selected.r, selected.c, r, c);
    }
}

function isMyPiece(val) { return turn === 'white' ? (val === 1 || val === 2) : val === 3; }
function getNotation(r, c) { return `${String.fromCharCode(97 + c)}${9 - r}`; }

function makeMove(r1, c1, r2, c2) {
    const piece = board[r1][c1]; board[r2][c2] = piece; board[r1][c1] = 0;
    playMoveSound();
    selected = null; movesCount++; 
    moveLog.push(`${getNotation(r1, c1)}-${getNotation(r2, c2)}`);
    checkCaptures(r2, c2);
    gameHistoryList.push(JSON.stringify(board));
    currentHistoryIndex = gameHistoryList.length - 1;
    turn = turn === 'white' ? 'black' : 'white';
    canUndoLocal = true; 
    
    saveGameState();

    if (checkWin()) return;
    const hash = JSON.stringify(board) + turn; historyHash[hash] = (historyHash[hash] || 0) + 1;
    if (historyHash[hash] >= 3) { endGame('Pareggio per ripetizione di mosse', 'info'); if(mode==='online') socket.emit('game_over', { gameId }); return; }
    
    updateMoveTable(); updateNavUI(); drawBoard(); updateUI(); updateButtonsUI();
    if (mode === 'online' && myColor !== turn) socket.emit('make_move', { gameId, moveData: {r1,c1,r2,c2} });
}

function updateMoveTable() {
    const tbody = document.getElementById('move-list-body'); if(!tbody) return;
    tbody.innerHTML = '';
    for (let i = 0; i < moveLog.length; i += 2) {
        const tr = document.createElement('tr');
        const tdNum = document.createElement('td'); tdNum.innerText = (i / 2) + 1 + ".";
        const tdBlack = document.createElement('td'); tdBlack.innerText = moveLog[i]; 
        const tdWhite = document.createElement('td'); if (moveLog[i+1]) tdWhite.innerText = moveLog[i+1]; else tdWhite.innerText = "-";
        tr.append(tdNum, tdBlack, tdWhite); tbody.appendChild(tr);
    }
    const container = document.getElementById('move-history-container'); if(container) container.scrollTop = container.scrollHeight;
}

function navigateHistory(dir) {
    const newIndex = currentHistoryIndex + dir;
    if (newIndex >= 0 && newIndex < gameHistoryList.length) { currentHistoryIndex = newIndex; drawBoard(); updateNavUI(); }
}
function updateNavUI() {
    const btnPrev = document.getElementById('btn-prev'), btnNext = document.getElementById('btn-next');
    if(btnPrev) btnPrev.disabled = (currentHistoryIndex === 0);
    if(btnNext) btnNext.disabled = (currentHistoryIndex === gameHistoryList.length - 1);
}

function getMoves(r, c) {
    let res = []; const dirs = [[0,1], [0,-1], [1,0], [-1,0]]; const isKing = board[r][c] === 2; 
    dirs.forEach(d => {
        let i = 1;
        while(true) {
            let nr = r + d[0]*i, nc = c + d[1]*i;
            if(nr<0||nr>8||nc<0||nc>8) break;
            const tVal = board[nr][nc], isThrone = (nr===4 && nc===4);
            if (isThrone) { if (tVal !== 0 || isKing) break; i++; continue; }
            if(tVal !== 0) break;
            if (!isKing && ((nr===0||nr===8) && (nc===0||nc===8))) break; 
            res.push({r: nr, c: nc}); if (isKing) break; i++;
        }
    }); return res;
}

function checkCaptures(r, c) {
    const me = board[r][c], isWhite = (me === 1 || me === 2), enemies = isWhite ? [3] : [1, 2], dirs = [[0,1], [0,-1], [1,0], [-1,0]];
    dirs.forEach(d => {
        const nr = r + d[0], nc = c + d[1], fr = r + d[0]*2, fc = c + d[1]*2; 
        if(nr>=0 && nr<9 && enemies.includes(board[nr][nc])) {
            const victim = board[nr][nc];
            if (victim === 2) { checkKingCapture(nr, nc); return; }
            if (fr>=0 && fr<9) {
                const anvil = board[fr][fc], isAnvilFriend = isWhite ? (anvil===1||anvil===2) : (anvil===3), isCorner = ((fr===0||fr===8) && (fc===0||fc===8)), isThrone = (fr===4 && fc===4);
                let capture = false;
                if (isAnvilFriend || isCorner) capture = true;
                else if (isThrone) {
                    const behindTr = fr + d[0], behindTc = fc + d[1];
                    if (behindTr>=0 && behindTr<9 && behindTc>=0 && behindTc<9) {
                        const bVal = board[behindTr][behindTc], isBehindFriend = isWhite ? (bVal===1||bVal===2) : (bVal===3);
                        if (isBehindFriend) capture = true;
                    }
                }
                if (capture) board[nr][nc] = 0; 
            }
        }
    });
}

function checkKingCapture(r, c) {
    let attackers = 0; const adj = [[r-1,c], [r+1,c], [r,c-1], [r,c+1]];
    adj.forEach(([ar, ac]) => {
        if (ar<0 || ar>8 || ac<0 || ac>8) attackers++; else if (board[ar][ac] === 3) attackers++; else if (ar===4 && ac===4) attackers++; 
    });
    if (attackers >= 4) triggerVictory('black', 'I Neri hanno catturato il Re!');
}

function checkWin() {
    let king = null; for(let i=0; i<9; i++) for(let j=0; j<9; j++) if(board[i][j]===2) king={r:i, c:j};
    if(!king) { triggerVictory('black', 'I Neri hanno catturato il Re!'); return true; }
    if((king.r===0||king.r===8) && (king.c===0||king.c===8)) { triggerVictory('white', 'Il Re è fuggito!'); return true; }
    return false;
}

function triggerVictory(winningColor, msg) {
    if (mode === 'local') {
        endGame(`Vittoria ${winningColor === 'white' ? 'Bianchi' : 'Neri'}! ${msg}`, 'win');
    } else {
        if (myColor === winningColor) endGame(msg, 'win');
        else endGame(msg, 'loss');
    }
}

function endGame(msg, type = 'info') {
    gameOver = true; 
    playWinSound();
    localStorage.removeItem('tablut_active_game');
    
    const modal = document.getElementById('game-result-modal');
    const titleEl = document.getElementById('result-title');
    
    if (type === 'win') {
        titleEl.innerText = "Vittoria!";
        titleEl.style.color = "#facc15"; 
    } else if (type === 'loss') {
        titleEl.innerText = "Sconfitta";
        titleEl.style.color = "#ef4444"; 
    } else if (type === 'cancelled') {
        titleEl.innerText = "Partita Annullata";
        titleEl.style.color = "#94a3b8"; 
    } else {
        titleEl.innerText = "Fine Partita";
        titleEl.style.color = "#facc15";
    }

    document.getElementById('result-msg').innerText = msg;
    modal.classList.remove('hidden');
    if(timerInterval) clearInterval(timerInterval);
}

function updateUI() {
    const el = document.getElementById('current-player');
    el.innerText = turn === 'black' ? "Neri" : "Bianchi";
    el.className = turn === 'black' ? "text-black" : "text-white"; 
}

function updateButtonsUI() {
    const btnsSurrender = [document.getElementById('surrender-btn'), document.getElementById('surrender-btn-mobile')];
    const btnsUndo = [document.getElementById('undo-btn'), document.getElementById('undo-btn-mobile')];
    const btnsRestart = [document.getElementById('restart-btn'), document.getElementById('restart-btn-mobile')];

    if (mode === 'local') {
        btnsSurrender.forEach(b => { if(b) { b.classList.add('hidden'); b.style.display = 'none'; } });
        btnsRestart.forEach(b => { if(b) { b.classList.remove('hidden'); b.style.display = 'block'; } });
        
        btnsUndo.forEach(b => {
            if(!b) return;
            b.innerText = "Annulla Ultima Mossa"; 
            b.disabled = (!canUndoLocal || movesCount === 0 || gameOver);
        });

    } else {
        btnsRestart.forEach(b => { if(b) { b.classList.add('hidden'); b.style.display = 'none'; } });
        btnsSurrender.forEach(b => {
            if(!b) return;
            b.classList.remove('hidden'); b.style.display = 'block';
            
            if (movesCount < 2) { 
                b.innerText = "Annulla Partita"; 
                b.classList.remove('btn-danger'); b.classList.add('btn-secondary'); 
            } else { 
                b.innerText = "Abbandona"; 
                b.classList.remove('btn-secondary'); b.classList.add('btn-danger'); 
            }
        });

        btnsUndo.forEach(b => {
            if(!b) return;
            b.innerText = `Annulla Mossa (${undosLeft})`; 
            b.disabled = (undosLeft <= 0 || gameOver);
        });
    }
}

function respondUndo(answer) {
    document.getElementById('undo-request-modal').classList.add('hidden');
    socket.emit('answer_undo', { gameId, answer });
}

// --- CONNESSIONE SOCKET ONLINE ---

function startSocketListeners() {
    socket.on('game_start', (data) => {
        gameId = data.gameId;
        const myName = document.getElementById('my-name').innerText;
        const isMeWhite = (data.white.trim() === myName.trim());
        const oppName = isMeWhite ? data.black : data.white;
        document.getElementById('opp-name').innerText = oppName;
        const myDot = document.getElementById('my-color');
        const oppDot = document.getElementById('opp-color');
        if (isMeWhite) { myDot.classList.add('is-white'); oppDot.classList.add('is-black'); } 
        else { myDot.classList.add('is-black'); oppDot.classList.add('is-white'); }
        startGame(); startPing();
    });

    socket.on('assign_color', (c) => { 
        myColor = c; 
        if(timers.white > 0) startTimer(); 
        saveGameState(); 
    });

    socket.on('opponent_move', (m) => { makeMove(m.r1, m.c1, m.r2, m.c2); });
    
    socket.on('game_over_forced', ({ winner, reason, surrendererColor }) => {
        localStorage.removeItem('tablut_active_game');
        if (reason === 'cancelled') {
            endGame("La partita è stata annullata prima dell'inizio.", 'cancelled');
        } else {
            if (myColor === surrendererColor) {
                endGame("Hai abbandonato la partita.", 'loss');
            } else {
                endGame("L'avversario ha abbandonato la partita.", 'win');
            }
        }
    });
    
    socket.on('undo_requested', () => { document.getElementById('undo-request-modal').classList.remove('hidden'); });
    socket.on('undo_accepted', (data) => {
        gameHistoryList.pop(); moveLog.pop();
        const prevState = gameHistoryList[gameHistoryList.length - 1];
        board = JSON.parse(prevState);
        turn = data.newTurn; movesCount--; currentHistoryIndex = gameHistoryList.length - 1;
        if (myColor === 'white') undosLeft = data.whiteUndos; else undosLeft = data.blackUndos;
        saveGameState();
        drawBoard(); updateUI(); updateButtonsUI(); updateMoveTable(); updateNavUI();
    });
    
    socket.on('undo_refused', () => alert("Rifiutato dall'avversario."));
    
    socket.on('opponent_connection_lost', () => {
        document.getElementById('opponent-warning').classList.remove('hidden');
        document.getElementById('opponent-warning').innerText = "⏳ L'avversario si è disconnesso. In attesa di riconnessione (Max 2 min)...";
    });
    socket.on('opponent_reconnected', () => {
        document.getElementById('opponent-warning').classList.add('hidden');
    });

    socket.on('game_over_timeout', ({ winner }) => {
        localStorage.removeItem('tablut_active_game');
        document.getElementById('opponent-warning').classList.add('hidden');
        if (myColor === winner) {
            endGame("L'avversario si è disconnesso definitivamente.", 'win');
        } else {
            endGame("Ti sei disconnesso per troppo tempo.", 'loss');
        }
    });

    socket.on('time_expired', (d) => {
        localStorage.removeItem('tablut_active_game');
        if (myColor === d.loser) {
            endGame("Il tuo tempo è scaduto.", 'loss');
        } else {
            endGame("Il tempo dell'avversario è scaduto.", 'win');
        }
    });
    
    socket.on('pong', () => { const ms = Date.now() - lastPing; updateSignal(ms); document.getElementById('connection-warning').classList.add('hidden'); });
    socket.on('connect_error', () => document.getElementById('connection-warning').classList.remove('hidden'));
}

function reconnectOnline() {
    document.getElementById('online-ui').classList.remove('hidden');
    document.getElementById('online-ui-bottom').classList.remove('hidden');
    
    socket = io('https://tablutgame.onrender.com', { 
        transports: ['websocket', 'polling'], reconnection: true 
    });

    startSocketListeners();

    socket.on('connect', () => {
        socket.emit('reconnect_game', { gameId, playerId });
    });

    updateUI(); updateButtonsUI(); updateMoveTable(); updateNavUI(); drawBoard();
    if(timers.white > 0) startTimer();
    startPing();
}

function initOnline(name, time) {
    document.getElementById('online-ui').classList.remove('hidden');
    document.getElementById('online-ui-bottom').classList.remove('hidden');
    document.getElementById('my-name').innerText = name;
    if (time !== 'no-time') { timers.white = parseInt(time)*60; timers.black = parseInt(time)*60; }
    
    socket = io('https://tablutgame.onrender.com', { 
        transports: ['websocket', 'polling'], reconnection: true 
    });

    startSocketListeners();
    socket.emit('find_game', { username: name, timeControl: time, playerId: playerId });
}

let lastPing = 0;
function startPing() { setInterval(() => { lastPing = Date.now(); socket.emit('ping'); }, 2000); }
function updateSignal(ms) {
    const el = document.getElementById('my-signal'); el.className = 'signal-bars';
    let q = 'signal-4'; if (ms > 500) q = 'signal-1'; else if (ms > 300) q = 'signal-2'; else if (ms > 100) q = 'signal-3'; 
    el.classList.add(q);
}
function startTimer() {
    if(timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(() => {
        if(gameOver) return;
        if(turn === 'white') timers.white--; else timers.black--;
        saveGameState(); 
        const fmt = (t) => { if(t<0) return "00:00"; let m=Math.floor(t/60), s=t%60; return `${m}:${s<10?'0'+s:s}`; };
        document.getElementById('my-timer').innerText = fmt(myColor==='white'?timers.white:timers.black);
        document.getElementById('opp-timer').innerText = fmt(myColor==='white'?timers.black:timers.white);
    }, 1000);
}
