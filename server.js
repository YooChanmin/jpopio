const express = require('express');
const http = require('http'); // Node.js HTTP Module
const { Server } = require("socket.io"); // Socket.io Module
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app); // Wrap app with http server
const io = new Server(server); // Create Socket.io server

const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());

// -------------------- Data Storage --------------------
const rooms = {}; // Room Data: { "CODE": { rounds, time, ... } }
const users = {}; // User Data: { "socketID": { nickname, room } }

// -------------------- Helper Functions --------------------
function generateRoomCode() {
    const characters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const length = 6;
    let result = '';
    for (let i = 0; i < length; i++) {
        const randomIndex = Math.floor(Math.random() * characters.length);
        result += characters.charAt(randomIndex);
    }
    return result;
}

function getUsersInRoom(roomCode) {
    const userList = [];
    for (const id in users) {
        if (users[id].room === roomCode) {
            userList.push(users[id].nickname);
        }
    }
    return userList;
}

// -------------------- HTTP Routes --------------------

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });
app.get('/createRoom', (req, res) => { res.sendFile(path.join(__dirname, 'createRoom.html')); });
app.get('/inGame', (req, res) => { res.sendFile(path.join(__dirname, 'inGame.html')); });

// Login API
app.post('/login', (req, res) => {
    const name = req.body.name;
    console.log(`[API] User logged in: ${name}`); // Log changed to English
    res.json({ success: true });
});

// Create Room API
app.post('/create-room-data', (req, res) => {
    const { rounds, time, hint, skipVoteRatio, chatMode, customList } = req.body;

    // Generate unique room code
    let roomCode;
    do {
        roomCode = generateRoomCode();
    } while (rooms[roomCode]);

    // Save room data
    rooms[roomCode] = {
        rounds,
        time,
        hint,
        skipVoteRatio,
        chatMode,
        customList: customList || [],
        players: []
    };

    console.log(`[API] Room Created. Code: ${roomCode}`);
    console.log(`      Settings: ${rounds} Rounds / ${time} sec / Custom Problems: ${customList ? customList.length : 0}`);

    res.json({ 
        success: true, 
        roomCode: roomCode, 
        message: "Room created successfully!" 
    });
});

// -------------------- Socket.io Logic --------------------

io.on('connection', (socket) => {
    console.log(`[Socket] New connection: ${socket.id}`);

    // 1. Join Room
    socket.on('join_room', (data) => {
        const { nickname, roomCode } = data;

        // Check if room exists
        if (!rooms[roomCode]) {
            socket.emit('error', { message: "Room not found" });
            return;
        }

        // Save user info
        users[socket.id] = {
            nickname: nickname,
            room: roomCode,
            score: 0
        };

        socket.join(roomCode);
        
        console.log(`[Socket] ${nickname} joined room [${roomCode}]`);

        // Notify others in the room
        io.to(roomCode).emit('user_joined', { 
            nickname: nickname, 
            users: getUsersInRoom(roomCode) 
        });
    });

    // 2. Disconnect
    socket.on('disconnect', () => {
        const user = users[socket.id];
        if (user) {
            console.log(`[Socket] User disconnected: ${user.nickname} (${socket.id})`);
            
            io.to(user.room).emit('user_left', { nickname: user.nickname });
            
            // Remove user from memory
            delete users[socket.id];
        } else {
            console.log(`[Socket] Unknown user disconnected: ${socket.id}`);
        }
    });
});

// -------------------- Server Start --------------------
server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});

// ... (기존 require 및 설정들) ...

// [기존 코드 유지] generateRoomCode 함수 ...

// -------------------- [수정/추가된 API] --------------------

// 1. [신규] 방 코드 미리 생성 (대기실 입장용)
app.get('/generate-code', (req, res) => {
    let roomCode;
    do {
        roomCode = generateRoomCode();
    } while (rooms[roomCode]);

    // 빈 방 생성 (설정은 나중에 덮어씌움)
    rooms[roomCode] = {
        rounds: 5, time: 30, // 기본값
        players: [],
        inGame: false
    };

    res.json({ roomCode });
});

// 2. [수정] 게임 시작 (설정 저장 및 게임 시작 신호)
app.post('/update-room-settings', (req, res) => {
    const { roomCode, rounds, time, hint, skipVoteRatio, chatMode, customList } = req.body;

    if (!rooms[roomCode]) {
        return res.json({ success: false, message: "방이 존재하지 않습니다." });
    }

    // 설정 덮어쓰기
    rooms[roomCode].rounds = rounds;
    rooms[roomCode].time = time;
    rooms[roomCode].hint = hint;
    rooms[roomCode].skipVoteRatio = skipVoteRatio;
    rooms[roomCode].chatMode = chatMode;
    rooms[roomCode].customList = customList || [];
    rooms[roomCode].inGame = true; // 게임 시작 플래그

    console.log(`[API] Game Started in Room ${roomCode}`);

    // ★ 방에 있는 모든 사람에게 '게임 시작했다'고 알림 (소켓)
    io.to(roomCode).emit('game_started');

    res.json({ success: true });
});

// ... (기존 Socket.io 로직 유지) ...
// 단, socket.on('join_room') 부분은 그대로 둬도 잘 작동합니다.