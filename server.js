const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('/', (req, res) => res.sendFile(__dirname + '/public/index.html'));
app.get('/createRoom', (req, res) => res.sendFile(__dirname + '/public/createRoom.html'));
app.get('/inGame', (req, res) => res.sendFile(__dirname + '/public/inGame.html'));

let rooms = {};

const defaultQuestions = [
    { link: "https://youtu.be/gdZLi9oWNZg", startTime: "0", answer: "BTS,Dynamite,다이너마이트", hint: "빌보드 1위" },
    { link: "https://youtu.be/d9IxdwEFk1c", startTime: "46", answer: "아이유,팔레트,Palette", hint: "지드래곤 피처링" },
    { link: "https://youtu.be/K9_VFxzCuQ0", startTime: "53", answer: "로제,아파트,APT", hint: "술게임" },
    { link: "https://youtu.be/pBuZEGYXA6E", startTime: "50", answer: "뉴진스,Ditto,디토", hint: "겨울 느낌" }
];

function getUniqueRoomCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    while (true) {
        result = '';
        for (let i = 0; i < 6; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
        if (!rooms[result]) return result;
    }
}

function normalizeAnswer(str) {
    if (!str) return "";
    return str.toString().trim().toLowerCase().replace(/[^a-z0-9가-힣]/g, '');
}

function shuffle(array) {
    const newArray = [...array];
    for (let i = newArray.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [newArray[i], newArray[j]] = [newArray[j], newArray[i]];
    }
    return newArray;
}

app.get('/generate-code', (req, res) => {
    const roomCode = getUniqueRoomCode();
    rooms[roomCode] = {
        players: [], 
        hostId: null, // ★ 방장 ID 추적 추가
        inGame: false, rounds: 5, time: 30, hint: 'off',
        skipVoteRatio: 'overHalf', chatMode: 'separated', customList: [],
        originalPool: [], activeQueue: [],  
        currentRound: 0, currentQuestion: null, timer: null, timeLeft: 0,
        deleteTimer: null, skipVotes: new Set()
    };
    res.json({ roomCode });
});

app.post('/update-room-settings', (req, res) => {
    const { roomCode, rounds, time, hint, skipVoteRatio, chatMode, customList } = req.body;
    if (!rooms[roomCode]) return res.json({ success: false, message: "방이 존재하지 않습니다." });
    const room = rooms[roomCode];

    let validCustom = [];
    if (Array.isArray(customList)) {
        validCustom = customList.filter(item => {
            if (!item.link || typeof item.link !== 'string' || !item.link.includes('youtu')) return false;
            if (item.link.includes('example')) return false;
            if (item.link.includes('?')) item.link = item.link.split('?')[0];
            if (item.link.includes('&')) item.link = item.link.split('&')[0];
            const isAnswerValid = item.answer && item.answer.trim() !== "";
            return isAnswerValid;
        });
    }

    if (validCustom.length > 0) { room.customList = validCustom; room.originalPool = validCustom; } 
    else { room.customList = []; room.originalPool = defaultQuestions; }
    
    room.activeQueue = shuffle(room.originalPool);
    room.rounds = parseInt(rounds) || 5;
    room.time = parseInt(time) || 30;
    room.hint = hint;
    room.skipVoteRatio = skipVoteRatio;
    room.chatMode = chatMode;
    room.inGame = true;
    room.currentRound = 0;
    room.players.forEach(p => { p.score = 0; p.isCorrect = false; });

    io.to(roomCode).emit('game_started');
    setTimeout(() => startNextRound(roomCode), 3000);
    res.json({ success: true });
});

function startNextRound(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;
    if (room.currentRound >= room.rounds) { endGame(roomCode); return; }

    room.currentRound++;
    room.timeLeft = room.time;
    room.skipVotes.clear();
    room.players.forEach(p => p.isCorrect = false);

    const requiredSkip = getSkipThreshold(room);
    io.to(roomCode).emit('skip_update', { current: 0, required: requiredSkip });

    if (room.activeQueue.length === 0) room.activeQueue = shuffle(room.originalPool);
    const question = room.activeQueue.pop();
    room.currentQuestion = question;

    io.to(roomCode).emit('round_start', {
        round: room.currentRound, totalRounds: room.rounds,
        link: question.link, startTime: question.startTime,
        hint: room.hint === 'on' ? question.hint : null,
        timeLimit: room.time,
        requiredSkip: requiredSkip
    });

    if (room.timer) clearInterval(room.timer);
    room.timer = setInterval(() => {
        room.timeLeft--;
        io.to(roomCode).emit('timer_update', room.timeLeft);
        if (room.timeLeft <= 0) endRound(roomCode, "⏰ 시간 초과!");
    }, 1000);
}

function getSkipThreshold(room) {
    if (room.skipVoteRatio === 'all') return room.players.length;
    if (room.skipVoteRatio === 'overHalf') return Math.ceil(room.players.length / 2);
    return 9999;
}

function endRound(roomCode, reason) {
    const room = rooms[roomCode];
    if(!room) return;
    clearInterval(room.timer);
    io.to(roomCode).emit('round_end', {
        reason: reason, 
        answer: room.currentQuestion.answer,
        scores: room.players.map(p => ({ nickname: p.nickname, score: p.score })),
        link: room.currentQuestion.link,
        startTime: room.currentQuestion.startTime
    });
    setTimeout(() => startNextRound(roomCode), 5000);
}

function endGame(roomCode) {
    const room = rooms[roomCode];
    if(!room) return;
    room.inGame = false;
    const sorted = [...room.players].sort((a, b) => b.score - a.score);
    io.to(roomCode).emit('game_over', { ranks: sorted });
}

io.on('connection', (socket) => {
    socket.on('join_room', (data) => {
        const { nickname, roomCode } = data;
        if (!rooms[roomCode]) { socket.emit('error_msg', "존재하지 않는 방입니다."); return; }
        
        socket.join(roomCode);
        socket.nickname = nickname;
        socket.roomCode = roomCode;

        if (rooms[roomCode].deleteTimer) {
            clearTimeout(rooms[roomCode].deleteTimer);
            rooms[roomCode].deleteTimer = null;
        }

        const room = rooms[roomCode];
        if(!room.players.find(p => p.id === socket.id)){
            room.players.push({ id: socket.id, nickname, score: 0, isCorrect: false });
        }

        // ★ 첫 입장 유저를 방장으로 설정
        if (!room.hostId) room.hostId = socket.id;

        io.to(roomCode).emit('user_joined', { users: room.players.map(p => p.nickname) });

        if (room.inGame) {
            socket.emit('game_started');
            if (room.currentQuestion) {
                const q = room.currentQuestion;
                const requiredSkip = getSkipThreshold(room);
                socket.emit('round_start', {
                    round: room.currentRound, totalRounds: room.rounds,
                    link: q.link, startTime: q.startTime,
                    hint: room.hint === 'on' ? q.hint : null,
                    timeLimit: room.time,
                    requiredSkip: requiredSkip
                });
                socket.emit('skip_update', { current: room.skipVotes.size, required: requiredSkip });
            }
        }
    });

    socket.on('update_settings', (data) => socket.to(data.roomCode).emit('settings_changed', data));

    socket.on('vote_skip', () => {
        const room = rooms[socket.roomCode];
        if (!room || !room.inGame || room.skipVoteRatio === 'noSkip') return;
        if (room.skipVotes.has(socket.id)) return;
        room.skipVotes.add(socket.id);
        const threshold = getSkipThreshold(room);
        io.to(socket.roomCode).emit('skip_update', { current: room.skipVotes.size, required: threshold });
        io.to(socket.roomCode).emit('chat_message', { nickname: 'System', msg: `${socket.nickname}님이 스킵 투표를 했습니다.`, type: 'system' });
        if (room.skipVotes.size >= threshold) endRound(socket.roomCode, "⏭️ 투표로 스킵되었습니다!");
    });

    socket.on('send_chat', (msg) => {
        const room = rooms[socket.roomCode];
        if (!room) return;
        if (!room.inGame) { io.to(socket.roomCode).emit('chat_message', { nickname: socket.nickname, msg: msg, type: 'chat' }); return; }
        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;

        if (player.isCorrect) {
            if (room.chatMode === 'separated') {
                room.players.forEach(p => { if (p.isCorrect) io.to(p.id).emit('chat_message', { nickname: socket.nickname, msg: msg, type: 'chat_gray' }); });
                return;
            }
            if (room.chatMode === 'censored') {
                const correctAnswers = room.currentQuestion.answer.split(',').map(a => a.trim());
                let censoredMsg = msg;
                correctAnswers.forEach(ans => { censoredMsg = censoredMsg.replace(new RegExp(ans, 'gi'), '***'); });
                room.players.forEach(p => {
                    if (p.isCorrect) io.to(p.id).emit('chat_message', { nickname: socket.nickname, msg: msg, type: 'chat_gray' });
                    else io.to(p.id).emit('chat_message', { nickname: socket.nickname, msg: censoredMsg, type: 'chat' });
                });
                return;
            }
            return;
        }

        const correctAnswers = room.currentQuestion.answer.split(',').map(a => normalizeAnswer(a));
        if (correctAnswers.includes(normalizeAnswer(msg))) {
            player.isCorrect = true;
            player.score += (room.timeLeft * 10);
            io.to(socket.roomCode).emit('correct_answer', { nickname: socket.nickname });
            io.to(socket.roomCode).emit('update_score', room.players.map(p => ({ nickname: p.nickname, score: p.score })));
            socket.emit('chat_message', { nickname: 'System', msg: '정답입니다! (이제 정답자 채팅이 활성화됩니다)', type: 'system_good' });
            if (room.players.every(p => p.isCorrect)) endRound(socket.roomCode, "🎉 모두 정답!");
        } else {
            io.to(socket.roomCode).emit('chat_message', { nickname: socket.nickname, msg: msg, type: 'chat' });
        }
    });

    socket.on('disconnect', () => {
        if(socket.roomCode && rooms[socket.roomCode]) {
            const room = rooms[socket.roomCode];
            room.players = room.players.filter(p => p.id !== socket.id);
            room.skipVotes.delete(socket.id);
            
            // ★ 방장이 나갔을 때 인계 로직
            if (room.hostId === socket.id && room.players.length > 0) {
                const newHost = room.players[0];
                room.hostId = newHost.id;
                io.to(socket.roomCode).emit('change_host', { newHostId: newHost.id, newHostName: newHost.nickname });
                io.to(socket.roomCode).emit('chat_message', { nickname: 'System', msg: `👑 [${newHost.nickname}]님이 새로운 방장이 되었습니다.`, type: 'system' });
            }

            io.to(socket.roomCode).emit('user_joined', { users: room.players.map(p => p.nickname) });
            if (room.inGame) io.to(socket.roomCode).emit('skip_update', { current: room.skipVotes.size, required: getSkipThreshold(room) });
            if (room.players.length === 0) {
                room.deleteTimer = setTimeout(() => { delete rooms[socket.roomCode]; }, 10000); 
            }
        }
    });
});

const PORT = 3000;
http.listen(PORT, () => { console.log(`Server running on http://localhost:${PORT}`); });