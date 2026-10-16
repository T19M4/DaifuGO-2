
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: [
      "https://t19m4.github.io"
    ],
    methods: ["GET", "POST"]
  }
});

const rooms = new Map();

app.get("/", (_req, res) => {
  res.send("DaifuGO-2 online server is running.");
});

function makeRoomCode() {
  return crypto.randomBytes(3).toString("hex").toUpperCase();
}

io.on("connection", (socket) => {
  socket.on("createRoom", ({ name }, callback) => {
    name = String(name || "").trim().slice(0, 6);

    if (!name) {
      return callback?.({
        ok: false,
        message: "名前を入力してください。"
      });
    }

    let code;
    do {
      code = makeRoomCode();
    } while (rooms.has(code));

    rooms.set(code, {
      players: [{
        id: socket.id,
        name
      }]
    });

    socket.join(code);
    socket.data.roomCode = code;

    callback?.({
      ok: true,
      roomCode: code,
      players: rooms.get(code).players
    });
  });

  socket.on("joinRoom", ({ roomCode, name }, callback) => {
    const code = String(roomCode || "")
      .trim()
      .toUpperCase();
    name = String(name || "").trim().slice(0, 6);

    const room = rooms.get(code);

    if (!name) {
      return callback?.({
        ok: false,
        message: "名前を入力してください。"
      });
    }

    if (!room) {
      return callback?.({
        ok: false,
        message: "部屋が見つかりません。"
      });
    }

    if (room.players.length >= 4) {
      return callback?.({
        ok: false,
        message: "この部屋は満員です。"
      });
    }

    room.players.push({
      id: socket.id,
      name
    });

    socket.join(code);
    socket.data.roomCode = code;

    io.to(code).emit("playersUpdated", room.players);

    callback?.({
      ok: true,
      roomCode: code,
      players: room.players
    });
  });

  socket.on("disconnect", () => {
    const code = socket.data.roomCode;
    if (!code) return;

    const room = rooms.get(code);
    if (!room) return;

    room.players = room.players.filter(
      player => player.id !== socket.id
    );

    if (room.players.length === 0) {
      rooms.delete(code);
    } else {
      io.to(code).emit("playersUpdated", room.players);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on port ${PORT}`);
});


