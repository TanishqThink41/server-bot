const express = require("express");
const cors = require("cors");
const session = require("express-session");
const cookieParser = require("cookie-parser");
const bodyParser = require("body-parser");
const mongoose = require("mongoose");
const User = require("./models/User");

require("dotenv").config();


const app = express();

// ─────────────────────────────────────────────────────────────────────────────
//  MONGOOSE CONNECTION
// ─────────────────────────────────────────────────────────────────────────────

const MONGOOSE_URI = process.env.MONGOOSE_URI

if (!MONGOOSE_URI) {
    console.error("Error: MONGOOSE_URI is not defined in the .env file");
    process.exit(1);
}

mongoose.connect(MONGOOSE_URI);
mongoose.connection.on("connected", () => {
  console.log("Connected to MongoDB");
});
mongoose.connection.on("error", (err) => {
  console.error("MongoDB connection error:", err);
});

// ─────────────────────────────────────────────────────────────────────────────
//  EXPRESS APP MIDDLEWARE
// ─────────────────────────────────────────────────────────────────────────────
app.use(
  cors({
    origin: true,
    credentials: true,
  })
);
app.use(bodyParser.json({ limit: "50mb" }));
app.use(bodyParser.urlencoded({ limit: "50mb", extended: true }));
app.use(cookieParser());

// Session (memory-based for demo; consider store for production)
app.use(
  session({
    secret: "some-secret-key",
    resave: false,
    saveUninitialized: false,
  })
);

// ─────────────────────────────────────────────────────────────────────────────
//  SSE Connections: keyed by username => { laptop: [], phone: [] }
// ─────────────────────────────────────────────────────────────────────────────
const connections = {};

// Utility function to broadcast an event to all SSE clients of a specific user
function broadcastToDeviceType(username, deviceType, eventData) {
  if (!connections[username]) return;
  connections[username][deviceType].forEach((res) => {
    res.write(`data: ${JSON.stringify(eventData)}\n\n`);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  AUTH & USER ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// Register a user (plain text password, for demonstration only)
app.post("/register", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ success: false, message: "Missing fields" });
  }

  // Check if user exists
  const existing = await User.findOne({ username }).exec();
  if (existing) {
    return res
      .status(400)
      .json({ success: false, message: "Username already taken" });
  }

  // Create new user (plain text password)
  const newUser = new User({ username, password });
  await newUser.save();

  return res.json({ success: true, message: "Registered successfully" });
});

// Login route
app.post("/login", async (req, res) => {
  const { username, password, deviceType } = req.body;
  if (!username || !password || !deviceType) {
    return res
      .status(400)
      .json({ success: false, message: "Missing login fields" });
  }

  // Check user in DB
  const user = await User.findOne({ username, password }).exec();
  if (!user) {
    return res.status(401).json({ success: false, message: "Invalid credentials" });
  }

  req.session.username = username;
  req.session.deviceType = deviceType;

  // Initialize connections array for user if not exist
  if (!connections[username]) {
    connections[username] = {
      laptop: [],
      phone: [],
    };
  }

  return res.json({ success: true, message: "Logged in", deviceType });
});

// Logout route
app.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    return res.json({ success: true, message: "Logged out" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  SSE ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────
app.get("/sse/laptop", (req, res) => {
  const username = req.session.username;
  if (!username || req.session.deviceType !== "laptop") {
    return res.status(403).send("Forbidden");
  }

  // Prepare SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // Add to connections
  connections[username].laptop.push(res);

  // Remove on close
  req.on("close", () => {
    connections[username].laptop = connections[username].laptop.filter(
      (client) => client !== res
    );
  });
});

app.get("/sse/phone", (req, res) => {
  const username = req.session.username;
  if (!username || req.session.deviceType !== "phone") {
    return res.status(403).send("Forbidden");
  }

  // Prepare SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // Add to connections
  connections[username].phone.push(res);

  // Remove on close
  req.on("close", () => {
    connections[username].phone = connections[username].phone.filter(
      (client) => client !== res
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  CHAT-LIKE ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

// Send image from laptop -> phone
app.post("/send-image", (req, res) => {
  const username = req.session.username;
  if (!username || req.session.deviceType !== "laptop") {
    return res.status(403).json({ message: "Forbidden" });
  }
  const { base64Image } = req.body;
  broadcastToDeviceType(username, "phone", { type: "image", data: base64Image });
  return res.json({ success: true });
});

// Send text from phone -> laptop
app.post("/send-text", (req, res) => {
  const username = req.session.username;
  if (!username || req.session.deviceType !== "phone") {
    return res.status(403).json({ message: "Forbidden" });
  }
  const { text } = req.body;
  broadcastToDeviceType(username, "laptop", { type: "text", data: text });
  return res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────────────────────
//  START SERVER
// ─────────────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});