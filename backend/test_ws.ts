import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:3001');

ws.on('open', function open() {
    console.log('✅ WebSocket Connected!');
    ws.close();
});

ws.on('error', function error(err) {
    console.log('❌ WebSocket Error:', err.message);
});
