const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const http = require("http");
const { Server } = require("socket.io");
require("dotenv").config();

const aiRoutes = require("./routes/ai");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "https://ai-thought.vercel.app/", methods: ["GET", "POST"] },
});

// === Middleware ===
app.use(express.json());
app.use(cors());
app.use("/", aiRoutes);

// === PostgreSQL Connection ===
const pool = new Pool({
  connectionString: process.env.SUPABASE_URL,
  ssl: { rejectUnauthorized: false },
  keepAlive: true,
});

// === AUTH ===
app.post("/signup", async (req, res) => {
  const { username, email, password } = req.body;
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    await pool.query(
      "INSERT INTO users (username, email, password) VALUES ($1, $2, $3)",
      [username, email, hashedPassword]
    );
    res.status(201).send("User registered");
  } catch (err) {
    console.error("Signup error:", err);
    res.status(500).send("Error signing up");
  }
});

app.post("/login", async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query("SELECT * FROM users WHERE email = $1", [
      email,
    ]);
    const user = result.rows[0];

    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).send("Invalid credentials");
    }

    const token = jwt.sign(
      { username: user.username, user_id: user.id },
      process.env.SECRET_KEY,
      { expiresIn: "1h" }
    );

    res.json({ token });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).send("Login failed");
  }
});

app.get("/chats", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM chats ORDER BY timestamp ASC"
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching chats:", err);
    res.status(500).send("Failed to fetch chats");
  }
});

app.post("/get-private-messages", async (req, res) => {
  const { from, to } = req.body;

  try {
    const result = await pool.query(
      `SELECT * FROM chats 
       WHERE 
         (username = $1 AND receiver = $2) OR 
         (username = $2 AND receiver = $1) 
       ORDER BY timestamp ASC`,
      [from, to]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching private messages:", err);
    res.status(500).send("Failed to fetch private messages");
  }
});

// === THOUGHTS WITH LIKES & COMMENTS ===

// Add a new AI Thought
app.post("/thoughts", async (req, res) => {
  const { username, content } = req.body;
  // console.log(user_id);

  try {
    await pool.query(
      `INSERT INTO thoughts ( username, content, likes, comments) 
       VALUES ($1, $2, $3, $4)`,
      [username, content, JSON.stringify(0), JSON.stringify([])]
    );
    res.status(201).send("Thought added successfully");
  } catch (err) {
    console.error("Error adding thought:", err);
    res.status(500).send("Failed to post thought");
  }
});

// Get all thoughts (newest first)
app.get("/thoughts", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 5;
    const offset = parseInt(req.query.offset) || 0;
    const result = await pool.query(
      `SELECT * FROM thoughts ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching thoughts:", err);
    res.status(500).send("Failed to fetch thoughts");
  }
});
app.post("/thoughts/:id/like", async (req, res) => {
  const { id } = req.params;
  console.log(id);

  try {
    await pool.query(
      `
      UPDATE thoughts
      SET likes = COALESCE(likes, 0) + 1
      WHERE id = $1
    `,
      [id]
    );

    res.status(200).json({ message: "Liked successfully" });
  } catch (err) {
    console.error("Like error:", err);
    res.status(500).json({ error: "Failed to like" });
  }
});
app.post("/thoughts/:id/comment", async (req, res) => {
  const { id } = req.params;
  const { username, comment } = req.body;

  try {
    await pool.query(
      `
      UPDATE thoughts
      SET comments = COALESCE(comments, '[]'::jsonb) || $1::jsonb
      WHERE id = $2
    `,
      [JSON.stringify([{ username, comment, created_at: new Date() }]), id]
    );

    res.status(200).json({ message: "Comment added" });
  } catch (err) {
    console.error("Comment error:", err);
    res.status(500).json({ error: "Failed to comment" });
  }
});

app.get("/users-with-thoughts", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        users.id, 
        users.username, 
        COUNT(thoughts.id)::int AS thought_count
      FROM users
      LEFT JOIN thoughts ON users.username = thoughts.username
      GROUP BY users.id, users.username
      ORDER BY thought_count DESC;
    `);
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching users with thoughts:", err);
    res.status(500).json({ error: "Failed to fetch users with thoughts" });
  }
});

// === SOCKET.IO ===
let onlineUsers = new Map(); // username -> socket.id

io.on("connection", (socket) => {
  console.log("⚡ A user connected:", socket.id);

  socket.on("registerUser", (username) => {
    console.log("✅ Registered user:", username);
    onlineUsers.set(username, socket.id);
    io.emit("onlineUsers", Array.from(onlineUsers.keys()));
  });

  socket.on(
    "privateMessage",
    async ({ username: from, receiver: to, message, timestamp }) => {
      const toSocketId = onlineUsers.get(to);
      console.log("📩 Private message:", { from, to, message, timestamp });

      try {
        await pool.query(
          "INSERT INTO chats (username, message, timestamp, receiver) VALUES ($1, $2, $3, $4)",
          [from, message, timestamp, to]
        );

        // Send to receiver
        if (toSocketId) {
          io.to(toSocketId).emit("privateMessage", {
            username: from,
            message,
            timestamp,
            receiver: to,
          });
        }

        // Send back to sender to sync UI
        io.to(socket.id).emit("privateMessage", {
          username: from,
          message,
          timestamp,
          receiver: to,
        });
      } catch (err) {
        console.error("Error saving message:", err);
      }
    }
  );

  socket.on("disconnect", () => {
    let disconnectedUser = null;
    for (const [username, id] of onlineUsers.entries()) {
      if (id === socket.id) {
        disconnectedUser = username;
        onlineUsers.delete(username);
        break;
      }
    }

    if (disconnectedUser) {
      console.log("❌ Disconnected:", disconnectedUser);
      io.emit("onlineUsers", Array.from(onlineUsers.keys()));
    }

    console.log("💨 Socket disconnected:", socket.id);
  });
});

server.listen(5000, () =>
  console.log("✅ Backend running at http://localhost:5000")
);
