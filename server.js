const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');
const fs = require('fs');

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const MAX_PLAYERS = 12;

app.get('/', (req, res) => res.sendFile(__dirname + '/public/index.html'));
app.get('/createRoom', (req, res) => res.sendFile(__dirname + '/public/createRoom.html'));
app.get('/inGame', (req, res) => res.sendFile(__dirname + '/public/inGame.html'));

// 문제 데이터 검증 및 예시 데이터(Example) 제거
function validateQuestionPool(pool) {
    const targetArray = Array.isArray(pool) ? pool : (pool && pool.questions ? pool.questions : []);
    
    if (!Array.isArray(targetArray)) return [];
    
    return targetArray.filter(item => {
        const hasLink = item.link && (item.link.includes('youtu.be') || item.link.includes('youtube.com'));
        const hasAnswer = item.answer && item.answer.toString().trim().length > 0;
        
        // isExample 필드 체크 및 객체 내 'example' 키워드 필터링
        const isNotExample = item.isExample !== true && 
                             item.isExample !== 'true' &&
                             !JSON.stringify(item).toLowerCase().includes('example');

        return hasLink && hasAnswer && isNotExample;
    });
}

function loadGenrePools() {
    const dataDir = path.join(__dirname, 'data');
    const pools = { random: [] };
    
    try {
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir);
            return pools;
        }

        const files = fs.readdirSync(dataDir);
        files.forEach(file => {
            const match = file.match(/^(.+)Default\.json$/i);
            if (match) {
                const genreName = match[1].toLowerCase();
                try {
                    const content = fs.readFileSync(path.join(dataDir, file), 'utf-8');
                    const parsed = JSON.parse(content);
                    const questions = validateQuestionPool(parsed);
                    
                    if (questions.length > 0) {
                        pools[genreName] = questions;
                        pools.random = pools.random.concat(questions);
                        console.log(`[Success] ${file} 로드 완료 (${questions.length}개)`);
                    }
                } catch (jsonErr) {
                    console.error(`[Error] ${file} 파싱 실패:`, jsonErr.message);
                }
            }
        });
    } catch (e) {
        console.error("[Critical] 데이터 로드 중 오류:", e);
    }
    return pools;
}

const rooms = {};
const genrePools = loadGenrePools();

function normalizeAnswer(str) {
    return str ? str.toString().trim().toLowerCase().replace(/[^a-z0-9가-힣]/g, '') : "";
}

function shuffle(array) {
    const newArray = [...array];
    for (let i = newArray.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [newArray[i], newArray[j]] = [newArray[j], newArray[i]];
    }
    return newArray;
}

function getUniqueRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    while (true) {
        code = '';
        for (let i = 0; i < 6; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
        if (!rooms[code]) return code;
    }
}

app.get('/generate-code', (req, res) => {
    const roomCode = getUniqueRoomCode();
    rooms[roomCode] = {
        players: [], hostId: null, inGame: false, rounds: 5, time: 30, hint: 'off',
        originalPool: [], activeQueue: [], currentRound: 0, currentQuestion: null,
        timer: null, timeLeft: 0, deleteTimer: null, skipVotes: new Set()
    };
    res.json({ roomCode });
});

app.post('/update-room-settings', (req, res) => {
    const { roomCode, rounds, time, hint, genre, customList } = req.body;
    const room = rooms[roomCode];
    if (!room) return res.json({ success: false });

    const validCustom = validateQuestionPool(customList);
    room.originalPool = validCustom.length > 0 ? validCustom : (genrePools[genre.toLowerCase()] || genrePools['random']);
    
    if (room.originalPool.length === 0) return res.json({ success: false });

    room.activeQueue = shuffle(room.originalPool);
    room.rounds = Math.min(parseInt(rounds) || 5, room.originalPool.length);
    room.time = parseInt(time) || 30;
    room.hint = hint;
    room.inGame = true;
    room.currentRound = 0;
    room.players.forEach(p => { p.score = 0; p.isCorrect = false; });

    io.to(roomCode).emit('game_started');
    setTimeout(() => startNextRound(roomCode), 3000);
    res.json({ success: true });
});

function startNextRound(roomCode) {
    const room = rooms[roomCode];
    if (!room || room.currentRound >= room.rounds) { endGame(roomCode); return; }

    room.currentRound++;
    room.timeLeft = room.time;
    room.skipVotes.clear();
    room.players.forEach(p => p.isCorrect = false);

    if (room.activeQueue.length === 0) room.activeQueue = shuffle(room.originalPool);
    room.currentQuestion = room.activeQueue.pop();

    const threshold = Math.ceil(room.players.length / 2);

    io.to(roomCode).emit('round_start', {
        round: room.currentRound,
        totalRounds: room.rounds,
        link: room.currentQuestion.link,
        startTime: room.currentQuestion.startTime || 0,
        hint: room.hint === 'on' ? room.currentQuestion.hint : null,
        timeLimit: room.time,
        requiredSkip: threshold,
        hostId: room.hostId
    });

    if (room.timer) clearInterval(room.timer);
    room.timer = setInterval(() => {
        room.timeLeft--;
        io.to(roomCode).emit('timer_update', room.timeLeft);
        if (room.timeLeft <= 0) endRound(roomCode, "⏰ 시간 초과!");
    }, 1000);
}

function endRound(roomCode, reason) {
    const room = rooms[roomCode];
    if(!room) return;
    clearInterval(room.timer);
    io.to(roomCode).emit('round_end', {
        reason: reason, 
        answer: room.currentQuestion.answer,
        scores: room.players.map(p => ({ id: p.id, nickname: p.nickname, score: p.score })),
        hostId: room.hostId
    });
    setTimeout(() => startNextRound(roomCode), 7000);
}

function endGame(roomCode) {
    const room = rooms[roomCode];
    if(!room) return;
    room.inGame = false;
    io.to(roomCode).emit('game_over', { ranks: [...room.players].sort((a, b) => b.score - a.score) });
}

io.on('connection', (socket) => {
    socket.on('join_room', (data) => {
        const { nickname, roomCode } = data;
        const room = rooms[roomCode];
        if (!room || room.players.length >= MAX_PLAYERS) return;

        socket.join(roomCode);
        socket.nickname = nickname;
        socket.roomCode = roomCode;
        if (room.deleteTimer) { clearTimeout(room.deleteTimer); room.deleteTimer = null; }
        if(!room.players.find(p => p.id === socket.id)) room.players.push({ id: socket.id, nickname, score: 0, isCorrect: false });
        if (!room.hostId) room.hostId = socket.id;

        io.to(roomCode).emit('user_joined', { 
            users: room.players.map(p => ({ id: p.id, nickname: p.nickname })),
            currentCount: room.players.length,
            maxCount: MAX_PLAYERS,
            hostId: room.hostId
        });
    });

    socket.on('vote_skip', () => {
        const room = rooms[socket.roomCode];
        if (!room || !room.inGame) return;
        room.skipVotes.add(socket.id);
        const threshold = Math.ceil(room.players.length / 2);
        io.to(socket.roomCode).emit('skip_update', { current: room.skipVotes.size, required: threshold });
        if (room.skipVotes.size >= threshold) endRound(socket.roomCode, "⏭️ 투표로 스킵되었습니다!");
    });

    socket.on('send_chat', (msg) => {
        const room = rooms[socket.roomCode];
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;

        if (!room.inGame) {
            io.to(socket.roomCode).emit('chat_message', { nickname: socket.nickname, msg, type: 'chat' });
            return;
        }
        if (player.isCorrect) {
            room.players.filter(p => p.isCorrect).forEach(p => io.to(p.id).emit('chat_message', { nickname: socket.nickname, msg, type: 'chat_gray' }));
            return;
        }
        
        const isCorrect = room.currentQuestion.answer.split(',').some(a => normalizeAnswer(a) === normalizeAnswer(msg));
        if (isCorrect) {
            player.isCorrect = true;
            player.score += (room.timeLeft * 10);
            io.to(socket.roomCode).emit('correct_answer', { nickname: socket.nickname });
            io.to(socket.roomCode).emit('update_score', { 
                players: room.players.map(p => ({ id: p.id, nickname: p.nickname, score: p.score })),
                hostId: room.hostId
            });
            if (room.players.every(p => p.isCorrect)) endRound(socket.roomCode, "🎉 모두 정답!");
        } else {
            io.to(socket.roomCode).emit('chat_message', { nickname: socket.nickname, msg, type: 'chat' });
        }
    });

    socket.on('disconnect', () => {
        const room = rooms[socket.roomCode];
        if(!room) return;
        room.players = room.players.filter(p => p.id !== socket.id);
        if (room.hostId === socket.id && room.players.length > 0) room.hostId = room.players[0].id;
        io.to(socket.roomCode).emit('user_joined', { 
            users: room.players.map(p => ({ id: p.id, nickname: p.nickname })),
            currentCount: room.players.length,
            maxCount: MAX_PLAYERS,
            hostId: room.hostId
        });
        if (room.players.length === 0) room.deleteTimer = setTimeout(() => { delete rooms[socket.roomCode]; }, 10000);
    });
});

const PORT = 3000;
http.listen(PORT, () => {
    console.log(`-----------------------------------------`);
    console.log(`Server is running!`);
    console.log(`Local: http://localhost:${PORT}`);
    console.log(`-----------------------------------------`);
});