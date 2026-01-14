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
app.get('/room', (req, res) => res.sendFile(__dirname + '/public/room.html'));

// 문제 데이터 검증 및 예시 데이터 필터링
function validateQuestionPool(pool) {
    const targetArray = Array.isArray(pool) ? pool : (pool && pool.questions ? pool.questions : []);
    if (!Array.isArray(targetArray)) return [];

    return targetArray.filter(item => {
        const hasLink = item.link && (item.link.includes('youtu.be') || item.link.includes('youtube.com'));
        const hasAnswer = item.answer && item.answer.toString().trim().length > 0;
        const isNotExample = item.isExample !== true &&
            item.isExample !== 'true' &&
            !JSON.stringify(item).toLowerCase().includes('example');
        return hasLink && hasAnswer && isNotExample;
    });
}

function loadGenrePools() {
    const dataDir = path.join(__dirname, 'data');
    const pools = {
        random: []
    };
    try {
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir);
            console.log("[Info] 데이터 디렉토리가 생성되었습니다.");
            return pools;
        }
        const files = fs.readdirSync(dataDir);
        files.forEach(file => {
            const match = file.match(/^(.+)Default\.json$/i);
            if (match) {
                const genreName = match[1].toLowerCase();
                try {
                    const content = fs.readFileSync(path.join(dataDir, file), 'utf-8');
                    const questions = validateQuestionPool(JSON.parse(content));
                    if (questions.length > 0) {
                        pools[genreName] = questions;
                        pools.random = pools.random.concat(questions);
                        console.log(`[Success] ${file} 로드 완료 (${questions.length}개)`);
                    }
                } catch (e) {
                    console.error(`[Error] ${file} 로드 실패:`, e.message);
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
        for (let i = 0; i < 6; i++) {
            code += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        if (!rooms[code]) return code;
    }
}

app.get('/generate-code', (req, res) => {
    const roomCode = getUniqueRoomCode();
    rooms[roomCode] = {
        players: [],
        hostId: null,
        hostNickname: null,
        inGame: false,
        rounds: 5,
        time: 30,
        hint: 'off',
        skipVoteRatio: 'overHalf',
        chatMode: 'separated',
        originalPool: [],
        activeQueue: [],
        currentRound: 0,
        currentQuestion: null,
        timer: null,
        timeLeft: 0,
        deleteTimer: null,
        hostTransferTimer: null,
        skipVotes: new Set(),
        acceptingAnswers: false
    };
    res.json({
        roomCode
    });
});

app.post('/update-room-settings', (req, res) => {
    const {
        roomCode: rawCode,
        rounds,
        time,
        hint,
        genre,
        customList,
        skipVoteRatio,
        chatMode
    } = req.body;
    const roomCode = rawCode ? rawCode.toUpperCase() : "";
    const room = rooms[roomCode];
    if (!room) return res.json({ success: false });

    const allInLobby = room.players.every(p => p.status === 'lobby');
    if (!allInLobby) return res.json({ success: false, msg: "모든 인원이 로비로 돌아와야 합니다." });

    let validPool = validateQuestionPool(customList);
    if (validPool.length === 0) {
        validPool = genrePools[genre.toLowerCase()] || genrePools['random'];
    }

    if (!validPool || validPool.length === 0) return res.json({ success: false });

    room.originalPool = validPool;
    room.activeQueue = shuffle(room.originalPool);
    room.rounds = Math.min(parseInt(rounds) || 5, room.originalPool.length);
    room.time = parseInt(time) || 30;
    room.hint = hint;
    room.skipVoteRatio = skipVoteRatio;
    room.chatMode = chatMode;
    room.inGame = true;
    room.currentRound = 0;
    room.players.forEach(p => {
        p.score = 0;
        p.isCorrect = false;
        p.status = 'playing';
    });

    io.to(roomCode).emit('chat_message', {
        nickname: '시스템',
        msg: '잠시 후 게임이 시작됩니다!',
        type: 'system'
    });
    io.to(roomCode).emit('game_started');
    setTimeout(() => startNextRound(roomCode), 3000);
    res.json({ success: true });
});

function getSkipThreshold(room) {
    const count = room.players.length;
    if (room.skipVoteRatio === 'noSkip') return 999;
    if (room.skipVoteRatio === 'all') return count;
    return Math.ceil(count / 2);
}

function startNextRound(roomCode) {
    const room = rooms[roomCode];
    if (!room || room.currentRound >= room.rounds) {
        endGame(roomCode);
        return;
    }

    room.currentRound++;
    room.timeLeft = room.time;
    room.skipVotes.clear();
    room.players.forEach(p => p.isCorrect = false);
    room.acceptingAnswers = true;

    if (room.activeQueue.length === 0) room.activeQueue = shuffle(room.originalPool);
    room.currentQuestion = room.activeQueue.pop();

    io.to(roomCode).emit('round_start', {
        round: room.currentRound,
        totalRounds: room.rounds,
        link: room.currentQuestion.link,
        startTime: room.currentQuestion.startTime || 0,
        hint: room.hint === 'on' ? room.currentQuestion.hint : null,
        timeLimit: room.time,
        requiredSkip: getSkipThreshold(room),
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
    if (!room) return;
    
    room.acceptingAnswers = false;
    clearInterval(room.timer);

    io.to(roomCode).emit('chat_message', {
        nickname: '시스템',
        msg: reason,
        type: 'system'
    });

    io.to(roomCode).emit('round_end', {
        reason: reason,
        answer: room.currentQuestion.answer,
        scores: room.players.map(p => ({
            id: p.id,
            nickname: p.nickname,
            score: p.score
        })),
        hostId: room.hostId
    });
    
    if (room.currentRound < room.rounds) {
        setTimeout(() => startNextRound(roomCode), 7000);
    } else {
        setTimeout(() => endGame(roomCode), 7000);
    }
}

function endGame(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;
    room.inGame = false;
    room.acceptingAnswers = false;
    
    const sorted = [...room.players].sort((a, b) => b.score - a.score);
    room.players.forEach(p => p.status = 'result');

    io.to(roomCode).emit('game_over', {
        ranks: sorted
    });
}

io.on('connection', (socket) => {
    socket.on('join_room', (data) => {
        const { nickname, roomCode: rawCode } = data;
        const roomCode = rawCode ? rawCode.toUpperCase() : "";
        const room = rooms[roomCode];

        if (!room) {
            socket.emit('room_not_found');
            return;
        }

        if (room.players.length >= MAX_PLAYERS) return;

        socket.join(roomCode);
        socket.nickname = nickname;
        socket.roomCode = roomCode;

        if (room.deleteTimer) {
            clearTimeout(room.deleteTimer);
            room.deleteTimer = null;
        }

        let player = room.players.find(p => p.nickname === nickname);
        if (player) {
            player.id = socket.id;
        } else {
            room.players.push({
                id: socket.id,
                nickname,
                score: 0,
                isCorrect: false,
                status: 'lobby'
            });
        }

        if (!room.hostNickname) {
            room.hostId = socket.id;
            room.hostNickname = nickname;
        } else if (room.hostNickname === nickname) {
            room.hostId = socket.id;
            if (room.hostTransferTimer) {
                clearTimeout(room.hostTransferTimer);
                room.hostTransferTimer = null;
            }
        }

        io.to(roomCode).emit('chat_message', {
            nickname: '시스템',
            msg: `${nickname}님이 입장하셨습니다.`,
            type: 'system'
        });
        io.to(roomCode).emit('user_joined', {
            users: room.players.map(p => ({
                id: p.id,
                nickname: p.nickname,
                status: p.status
            })),
            currentCount: room.players.length,
            maxCount: MAX_PLAYERS,
            hostId: room.hostId,
            inGame: room.inGame
        });
    });

    socket.on('back_to_lobby', () => {
        const room = rooms[socket.roomCode];
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if (player) {
            player.status = 'lobby';
            io.to(socket.roomCode).emit('user_joined', { 
                users: room.players.map(p => ({ id: p.id, nickname: p.nickname, status: p.status })),
                currentCount: room.players.length,
                maxCount: MAX_PLAYERS,
                hostId: room.hostId,
                inGame: room.inGame
            });
        }
    });

    socket.on('vote_skip', () => {
        const room = rooms[socket.roomCode];
        if (!room || !room.inGame || !room.acceptingAnswers) return;
        room.skipVotes.add(socket.id);
        const threshold = getSkipThreshold(room);
        io.to(socket.roomCode).emit('chat_message', {
            nickname: '시스템',
            msg: `${socket.nickname}님이 스킵에 투표했습니다. (${room.skipVotes.size}/${threshold})`,
            type: 'system'
        });
        io.to(socket.roomCode).emit('skip_update', {
            current: room.skipVotes.size,
            required: threshold
        });
        if (room.skipVotes.size >= threshold) endRound(socket.roomCode, "⏭️ 투표로 스킵되었습니다!");
    });

    socket.on('kick_player', (targetId) => {
        const room = rooms[socket.roomCode];
        if (!room || room.hostId !== socket.id || targetId === socket.id) return;
        const targetPlayer = room.players.find(p => p.id === targetId);
        if (targetPlayer) {
            io.to(socket.roomCode).emit('chat_message', {
                nickname: '시스템',
                msg: `${targetPlayer.nickname}님이 퇴장당했습니다.`,
                type: 'system'
            });
            io.to(targetId).emit('kicked');
            const targetSocket = io.sockets.sockets.get(targetId);
            if (targetSocket) targetSocket.leave(socket.roomCode);
        }
    });

    socket.on('send_chat', (msg) => {
        const room = rooms[socket.roomCode];
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;

        if (!room.inGame) {
            io.to(socket.roomCode).emit('chat_message', {
                nickname: socket.nickname,
                msg,
                type: 'chat'
            });
            return;
        }

        if (room.acceptingAnswers && !player.isCorrect) {
            const answers = room.currentQuestion.answer.split(',').map(a => a.trim());
            const isCorrectInput = answers.some(a => normalizeAnswer(a) === normalizeAnswer(msg));

            if (isCorrectInput) {
                player.isCorrect = true;
                player.score += (room.timeLeft * 10);
                io.to(socket.roomCode).emit('correct_answer', {
                    nickname: socket.nickname
                });
                io.to(socket.roomCode).emit('update_score', {
                    players: room.players.map(p => ({
                        id: p.id,
                        nickname: p.nickname,
                        score: p.score,
                        status: p.status
                    })),
                    hostId: room.hostId
                });
                if (room.players.every(p => p.isCorrect)) endRound(socket.roomCode, "🎉 모두 정답!");
                return;
            }
        }

        if (player.isCorrect) {
            const answers = room.currentQuestion.answer.split(',').map(a => a.trim());
            if (room.chatMode === 'separated') {
                room.players.filter(p => p.isCorrect).forEach(p => {
                    io.to(p.id).emit('chat_message', {
                        nickname: socket.nickname,
                        msg,
                        type: 'chat_gray'
                    });
                });
            } else if (room.chatMode === 'censored') {
                let censoredMsg = msg;
                let highlightedMsg = msg;
                answers.forEach(a => {
                    if (a.length > 0) {
                        const reg = new RegExp(a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
                        censoredMsg = censoredMsg.replace(reg, '***');
                        highlightedMsg = highlightedMsg.replace(reg, `<span class="chat-gray-word">$&</span>`);
                    }
                });

                room.players.forEach(p => {
                    if (p.isCorrect) {
                        io.to(p.id).emit('chat_message', {
                            nickname: socket.nickname,
                            msg: highlightedMsg,
                            type: 'chat_html'
                        });
                    } else {
                        io.to(p.id).emit('chat_message', {
                            nickname: socket.nickname,
                            msg: censoredMsg,
                            type: 'chat'
                        });
                    }
                });
            }
        } else {
            io.to(socket.roomCode).emit('chat_message', {
                nickname: socket.nickname,
                msg,
                type: 'chat'
            });
        }
    });

    socket.on('disconnect', () => {
        const room = rooms[socket.roomCode];
        if (!room) return;
        const isHost = (room.hostId === socket.id);
        const nickname = socket.nickname;
        room.players = room.players.filter(p => p.id !== socket.id);
        if (nickname) {
            io.to(socket.roomCode).emit('chat_message', {
                nickname: '시스템',
                msg: `${nickname}님이 퇴장하셨습니다.`,
                type: 'system'
            });
        }
        if (isHost && room.players.length > 0) {
            room.hostTransferTimer = setTimeout(() => {
                if (room.players.length > 0) {
                    const newHost = room.players[0];
                    room.hostId = newHost.id;
                    room.hostNickname = newHost.nickname;
                    io.to(socket.roomCode).emit('chat_message', {
                        nickname: '시스템',
                        msg: `방장이 ${newHost.nickname}로 변경되었습니다.`,
                        type: 'system'
                    });
                    io.to(socket.roomCode).emit('change_host', {
                        newHostId: room.hostId
                    });
                }
            }, 3000);
        }

        io.to(socket.roomCode).emit('user_joined', {
            users: room.players.map(p => ({
                id: p.id,
                nickname: p.nickname,
                status: p.status
            })),
            currentCount: room.players.length,
            maxCount: MAX_PLAYERS,
            hostId: room.hostId,
            inGame: room.inGame
        });

        if (room.players.length === 0) {
            room.deleteTimer = setTimeout(() => {
                delete rooms[socket.roomCode];
            }, 10000);
        }
    });
});

const PORT = 3000;
http.listen(PORT, () => {
    console.log(`-----------------------------------------`);
    console.log(`Server is running!`);
    console.log(`Local: http://localhost:${PORT}`);
    console.log(`-----------------------------------------`);
});