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

// 2. 데이터 받는 API
app.post('/login', (req, res) => {
    const name = req.body.name;
    console.log("접속한 유저 이름:", name);
    res.json({ success: true }); // 성공 응답 보냄
});

// 4. 방 설정 데이터 처리
app.post('/create-room-data', (req, res) => {
    const rounds = req.body.rounds;
    const time = req.body.time;
    console.log(`방 생성 요청: ${rounds}라운드 / ${time}초`);
    
    res.json({ 
        success: true, 
        message: "방이 생성되었습니다!" 
    });
});

app.listen(PORT, () => {
    console.log(`서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
});