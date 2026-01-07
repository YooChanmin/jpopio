const express = require('express');
const cors = require('cors');
const path = require('path'); // 파일 경로를 다루기 위해 필요
const app = express();
const PORT = 3000;

// 미들웨어 설정
app.use(cors());
app.use(express.json());

// 1. 메인 페이지 접속 시 index.html 파일 보여주기 (이게 빠져서 에러가 난 것임)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/createRoom', (req, res) => {
    res.sendFile(path.join(__dirname, 'createRoom.html'));
});

app.get('/inGame', (req, res) => {
    res.sendFile(path.join(__dirname, 'inGame.html'));
});

// 2. 데이터 받는 API
app.post('/login', (req, res) => {
    const name = req.body.name;
    console.log("accessed username:", name);
    res.json({ success: true }); // 성공 응답 보냄
});

// 4. 방 설정 데이터 처리
app.post('/create-room-data', (req, res) => {
    const rounds = req.body.rounds;
    const time = req.body.time;
    const hint = req.body.hint;
    const skipVoteRatio = req.body.skipVoteRatio;
    const chatMode = req.body.chatMode;
    console.log(`create room request: ${rounds} rounds / ${time} sec / hint ${hint} / skip vote ratio ${skipVoteRatio} / chat mode ${chatMode}`);
    
    res.json({ 
        success: true, 
        message: "room created" 
    });
});

app.listen(PORT, () => {
    console.log(`server running at http://localhost:${PORT}`);
});