const { Server, Room } = require("@colyseus/core");
const { WebSocketTransport } = require("@colyseus/ws-transport");
const { Schema, MapSchema } = require("@colyseus/schema");
const express = require("express");
const cors = require("cors");
const { playground } = require("@colyseus/playground");

// ---------- Schemas (Schema 4.x compatible – no type() calls) ----------
class PlayerState extends Schema {
  constructor() {
    super();
    this.x = 150; this.y = 415; this.vx = 0; this.vy = 0;
    this.isJumping = false; this.color = "#ff00ff"; this.side = "left";
    this.name = ""; this.ready = false; this.accelX = 0;
    this.reconnecting = false;
    this.disconnectTime = 0;
  }
}
PlayerState._schema = {
  x: "number", y: "number", vx: "number", vy: "number",
  isJumping: "boolean", color: "string", side: "string",
  name: "string", ready: "boolean", accelX: "number",
  reconnecting: "boolean",
  disconnectTime: "number"
};

class BallState extends Schema {
  constructor() { super(); this.x = 500; this.y = 250; this.vx = 5; this.vy = -3; }
}
BallState._schema = { x: "number", y: "number", vx: "number", vy: "number" };

class KeeperState extends Schema {
  constructor() { super(); this.y = 250; this.vy = 0; }
}
KeeperState._schema = { y: "number", vy: "number" };

class GameState extends Schema {
  constructor() {
    super();
    this.players = new MapSchema();
    this.ball = new BallState();
    this.keeper1 = new KeeperState();
    this.keeper2 = new KeeperState();
    this.p1Score = 0; this.p2Score = 0; this.timeLeft = 120;
    this.gameOver = false; this.winnerMessage = "";
    this.matchState = "waiting";
    this.hostId = ""; this.roomCode = "";
    this.countdown = -1; this.goalFreeze = 0;
    this.password = ""; this.lastWinner = "";
  }
}
GameState._schema = {
  players: { map: PlayerState },
  ball: BallState,
  keeper1: KeeperState, keeper2: KeeperState,
  p1Score: "number", p2Score: "number", timeLeft: "number",
  gameOver: "boolean", winnerMessage: "string",
  matchState: "string", hostId: "string", roomCode: "string",
  countdown: "number", goalFreeze: "number",
  password: "string", lastWinner: "string"
};

// ---------- Room (unchanged) ----------
class FootballRoom extends Room {
  constructor() {
    super();
    this.maxClients = 2;
    this.state = new GameState();
    this.inputs = {};
    this.targetGoals = 10;
    this.reconnectTimers = {};
  }

  onCreate(options) {
    this.state.roomCode = this.roomId;
    this.state.password = options.password || Math.random().toString(36).substr(2, 6);

    this.onMessage("setName", (client, name) => {
      const player = this.state.players.get(client.sessionId);
      if (player) { player.name = name; }
      this.broadcastPlayerInfo();
    });

    this.onMessage("ready", (client) => {
      const player = this.state.players.get(client.sessionId);
      if (player) { player.ready = !player.ready; }
      this.broadcastPlayerInfo();
      if (this.state.players.size === 2 && [...this.state.players.values()].every(p => p.ready)) {
        this.state.matchState = "ready_check";
        this.startCountdown();
      }
    });

    this.onMessage("move", (client, input) => {
      if (typeof input === "object") {
        this.inputs[client.sessionId] = {
          left: !!input.left, right: !!input.right,
          up: !!input.up, down: !!input.down,
          shoot: !!input.shoot, turbo: !!input.turbo
        };
      }
    });

    this.onMessage("chat", (client, msg) => {
      const sender = this.state.players.get(client.sessionId)?.name || "Unknown";
      this.broadcast("chat", { sender, text: (msg || "").substring(0, 200) });
    });

    this.onMessage("emote", (client, emoteId) => {
      const player = this.state.players.get(client.sessionId);
      if (player) this.broadcast("emote", { playerName: player.name, emoteId });
    });

    this.onMessage("ping", (client, data) => client.send("pong", data));

    this.onMessage("rematch", (client) => {
      if (this.state.matchState !== "end") return;
      this.state.players.forEach(p => {
        p.x = p.side === "left" ? 150 : 820; p.y = 415; p.vx = 0; p.vy = 0;
        p.isJumping = false; p.ready = false;
      });
      this.state.ball.x = 500; this.state.ball.y = 250;
      this.state.ball.vx = 5; this.state.ball.vy = -3;
      this.state.p1Score = 0; this.state.p2Score = 0;
      this.state.timeLeft = 120;
      this.state.gameOver = false; this.state.winnerMessage = "";
      this.state.matchState = "waiting"; this.state.countdown = -1;
      this.state.goalFreeze = 0;
      this.broadcast("rematch");
      this.broadcastPlayerInfo();
    });

    this.setSimulationInterval((dt) => this.gameTick(), 1000 / 30);
  }

  onJoin(client, options) {
    const pass = options?.password;
    if (pass !== this.state.password) {
      client.send("error", { message: "Incorrect password" });
      client.leave();
      return;
    }

    const existingPlayer = this.state.players.get(client.sessionId);
    if (existingPlayer) {
      existingPlayer.reconnecting = false;
      if (this.reconnectTimers[client.sessionId]) {
        clearTimeout(this.reconnectTimers[client.sessionId]);
        delete this.reconnectTimers[client.sessionId];
      }
      this.broadcast("playerReconnected", {});
      this.broadcastPlayerInfo();
      return;
    }

    if (this.clients.length >= 2) {
      client.send("error", { message: "Room is full" });
      client.leave();
      return;
    }

    const player = new PlayerState();
    const isP1 = this.clients.length === 1;
    if (isP1) this.state.hostId = client.sessionId;
    player.x = isP1 ? 150 : 820;
    player.y = 415;
    player.color = isP1 ? "#ff00ff" : "#00f2ff";
    player.side = isP1 ? "left" : "right";
    this.state.players.set(client.sessionId, player);
    this.broadcastPlayerInfo();
  }

  onLeave(client) {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    player.reconnecting = true;
    player.disconnectTime = Date.now();
    this.broadcast("opponentReconnecting", { sessionId: client.sessionId });

    this.reconnectTimers[client.sessionId] = setTimeout(() => {
      if (player.reconnecting) {
        this.state.players.delete(client.sessionId);
        this.broadcastPlayerInfo();
        this.broadcast("playerLeft", {});
      }
    }, 30000);
  }

  broadcastPlayerInfo() {
    const p1 = [...this.state.players.values()].find(p => p.side === "left");
    const p2 = [...this.state.players.values()].find(p => p.side === "right");
    this.broadcast("playerNames", {
      p1: p1?.name || "—", p2: p2?.name || "—",
      p1Ready: p1?.ready || false, p2Ready: p2?.ready || false,
      password: this.state.password
    });
  }

  startCountdown() {
    this.state.matchState = "countdown";
    this.state.countdown = 3;
    this.broadcast("countdown", { value: this.state.countdown });
    const interval = setInterval(() => {
      if (this.state.matchState !== "countdown") { clearInterval(interval); return; }
      this.state.countdown--;
      if (this.state.countdown <= 0) {
        clearInterval(interval);
        this.state.matchState = "live";
        this.broadcast("gameStarted");
        this.broadcast("event", { type: "MUSIC_NEXT" });
      } else {
        this.broadcast("countdown", { value: this.state.countdown });
      }
    }, 1000);
  }

  gameTick() {
    if (this.state.matchState !== "live" || this.state.gameOver || this.state.players.size < 2) return;
    if (this.state.goalFreeze > 0) {
      this.state.goalFreeze--;
      if (this.state.goalFreeze === 0) this.broadcast("event", { type: "FREEZE_END" });
      return;
    }

    const FIXED_DT = 1 / 30;
    const ball = this.state.ball;

    this.state.players.forEach((player, sid) => {
      const input = this.inputs[sid] || {};
      const dx = player.x + 15 - ball.x, dy = player.y + 32 - ball.y, hasBall = dx * dx + dy * dy < 2500;

      if (hasBall && (input.shoot || input.turbo)) {
        player.vx = 0;
        const speed = input.turbo ? 45 : 20;
        ball.vx = player.side === "left" ? speed : -speed;
        if (input.up && !input.down) ball.vy = -14;
        else if (input.down) ball.vy = 10;
        else ball.vy = -2;
        this.broadcast("event", { type: "SHOT", data: { turbo: input.turbo, color: player.color } });
      } else {
        const accel = 0.6;
        if (input.left) player.accelX -= accel;
        if (input.right) player.accelX += accel;
        if (!input.left && !input.right) player.accelX *= 0.85;
        player.accelX = Math.min(Math.max(player.accelX, -3), 3);
        player.vx += player.accelX;
        player.vx *= 0.9;
        if (input.up && !player.isJumping) { player.vy = -14; player.isJumping = true; }
        if (input.down) player.vy += 1;
      }
    });

    ball.x += ball.vx * FIXED_DT * 60;
    ball.y += ball.vy * FIXED_DT * 60;
    ball.vy += 0.25 * FIXED_DT * 60;
    ball.vx *= 0.995;
    if (ball.y > 480) { ball.y = 480; ball.vy *= -0.7; }
    if (ball.y < 10) { ball.y = 10; ball.vy *= -0.7; }

    [{ x: 5, k: this.state.keeper1 }, { x: 983, k: this.state.keeper2 }].forEach(({ x: kx, k }) => {
      if (ball.x + 10 > kx && ball.x - 10 < kx + 12 && ball.y + 10 > k.y && ball.y - 10 < k.y + 60) {
        if (Math.abs(ball.vx) > 25) this.broadcast("event", { type: "SHOT", data: { turbo: false, color: "#fff" } });
        ball.vx *= -1.1; ball.x = kx < 500 ? 25 : 970;
      }
    });
    this.state.players.forEach(p => {
      if (ball.x + 10 > p.x && ball.x - 10 < p.x + 30 && ball.y + 10 > p.y && ball.y - 10 < p.y + 65) {
        const rvx = ball.vx - p.vx, rvy = ball.vy - p.vy;
        ball.vx = p.vx - rvx * 0.6; ball.vy = p.vy - rvy * 0.6;
        ball.x = ball.x < p.x + 15 ? p.x - 11 : p.x + 31;
      }
    });

    if (ball.x < 0 || ball.x > 1000) {
      if (ball.y > 150 && ball.y < 350) {
        if (ball.x < 0) this.state.p2Score++; else this.state.p1Score++;
        this.broadcast("event", { type: "GOAL", data: { scorer: ball.x < 0 ? "p2" : "p1", color: ball.x < 0 ? "#00f2ff" : "#ff00ff" } });
        this.state.goalFreeze = 60;
        ball.x = 500; ball.y = 250; ball.vx = (Math.random() > 0.5 ? 5 : -5); ball.vy = -3;
        if (this.state.p1Score >= this.targetGoals || this.state.p2Score >= this.targetGoals) {
          this.state.gameOver = true; this.state.matchState = "end";
          this.state.winnerMessage = this.state.p1Score >= this.targetGoals ? "Player 1 Wins!" : "Player 2 Wins!";
          this.state.lastWinner = this.state.p1Score >= this.targetGoals ? "p1" : "p2";
        }
      } else { ball.vx *= -1; ball.x = ball.x < 0 ? 5 : 995; }
    }

    const targetY = ball.y - 30;
    [this.state.keeper1, this.state.keeper2].forEach((k, i) => {
      k.vy += (targetY - k.y) * (i === 0 ? 0.12 : 0.1);
      k.vy *= 0.7; k.y += k.vy * FIXED_DT * 60;
      k.y = Math.min(295, Math.max(155, k.y));
    });

    this.state.players.forEach(p => {
      p.vy += 0.7; p.x += p.vx * FIXED_DT * 60; p.y += p.vy * FIXED_DT * 60; p.vx *= 0.85;
      if (p.y > 415) { p.y = 415; p.vy = 0; p.isJumping = false; }
      p.x = Math.min(930, Math.max(40, p.x));
    });

    if (this.state.timeLeft > 0) {
      this.state.timeLeft -= FIXED_DT;
      if (this.state.timeLeft <= 0) {
        this.state.gameOver = true; this.state.matchState = "end";
        this.state.winnerMessage = this.state.p1Score > this.state.p2Score ? "Player 1 Wins!" : (this.state.p2Score > this.state.p1Score ? "Player 2 Wins!" : "Draw!");
        this.state.lastWinner = this.state.p1Score > this.state.p2Score ? "p1" : (this.state.p2Score > this.state.p1Score ? "p2" : "draw");
      }
    }
  }
}

// ---------- Express & Colyseus server ----------
const app = express();
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json());

app.get("/", (_, res) => res.send("Football server is running ✅"));
app.get("/health", (_, res) => res.send("OK"));

// Custom Playground landing – forces wss://
app.get("/playground", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8" />
      <title>Colyseus Playground</title>
      <script src="/playground/js/app.js"></script>
      <link rel="stylesheet" href="/playground/css/app.css" />
    </head>
    <body>
      <script>
        window.__COLYSEUS_ENDPOINT__ = "wss://" + location.host;
      </script>
      <div id="app"></div>
    </body>
    </html>
  `);
});
// Still serve the Playground static assets (JS, CSS)
app.use("/playground", playground);

const port = process.env.PORT || 2567;
const httpServer = app.listen(port, () => {
  console.log(`⚡ HTTP server listening on port ${port}`);
});

const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer })
});
gameServer.define("football", FootballRoom);
console.log(`⚡ Colyseus WebSocket ready on port ${port}`);
