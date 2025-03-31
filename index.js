require("dotenv").config();

const express = require("express");
const cors = require("cors");
const session = require("express-session");
const MongoStore = require("connect-mongo");
const cookieParser = require("cookie-parser");
const bodyParser = require("body-parser");
const mongoose = require("mongoose");
const User = require("./models/User");

const app = express();

// ─────────────────────────────────────────────────────────────────────────────
//  MONGOOSE CONNECTION
// ─────────────────────────────────────────────────────────────────────────────
const MONGOOSE_URI = process.env.MONGOOSE_URI;

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

// If running behind a proxy (e.g., Render, Heroku) with HTTPS, trust the proxy
app.set("trust proxy", 1);

// ─────────────────────────────────────────────────────────────────────────────
//  EXPRESS APP MIDDLEWARE
// ─────────────────────────────────────────────────────────────────────────────

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",")
  : "https://client-bot-rose.vercel.app";

  app.use(
    cors({
      origin: (origin, callback) => {
        // Allow requests with no origin (like mobile apps, curl, etc.)
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) {
          return callback(null, true);
        }
        const msg =
          "The CORS policy for this site does not allow access from the specified origin.";
        return callback(new Error(msg), false);
      },
      credentials: true,
    })
  );


app.use(bodyParser.json({ limit: "50mb" }));
app.use(bodyParser.urlencoded({ limit: "50mb", extended: true }));
app.use(cookieParser());

// ─────────────────────────────────────────────────────────────────────────────
//  SESSION CONFIGURATION WITH connect-mongo
// ─────────────────────────────────────────────────────────────────────────────
app.use(
  session({
    secret: process.env.SESSION_SECRET || "fallback-secret-key",
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
      mongoUrl: MONGOOSE_URI,
    }),
    cookie: {
      // Example: 3 hours
      maxAge: 3000 * 60 * 60,
      // Needed for cross-site requests:
      sameSite: "none",
      // Must be true if your site is served over HTTPS (e.g., Render):
      secure: true,
    },
  })
);

// ─────────────────────────────────────────────────────────────────────────────
//  SSE Connections: keyed by username => { laptop: [], phone: [] }
// ─────────────────────────────────────────────────────────────────────────────
const connections = {};

/**
 * Broadcast an event (any JSON object) to all SSE clients
 * of a particular device type for a given username.
 */
function broadcastToDeviceType(username, deviceType, eventData) {
  if (!connections[username]) return;
  connections[username][deviceType].forEach((res) => {
    // Convert the eventData object to JSON, then embed it in SSE "data:"
    res.write(`data: ${JSON.stringify(eventData)}\n\n`);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  AUTH & USER ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// Register a user (plain text passwords are not secure, but used here for demo)
// app.post("/register", async (req, res) => {
//   const { username, password } = req.body;
//   if (!username || !password) {
//     return res.status(400).json({ success: false, message: "Missing fields" });
//   }

//   // Check if user exists
//   const existingUser = await User.findOne({ username }).exec();
//   if (existingUser) {
//     return res
//       .status(400)
//       .json({ success: false, message: "Username already taken" });
//   }

//   // Create new user
//   const newUser = new User({ username, password });
//   await newUser.save();

//   return res.json({ success: true, message: "Registered successfully" });
// });

// Login route
app.post("/login", async (req, res) => {
  let { username, password, deviceType } = req.body;

  if (!username || !password) {
    return res
      .status(400)
      .json({ success: false, message: "Missing login fields" });
  }

  // Set default deviceType to "phone" if not provided
  if (!deviceType) {
    deviceType = "phone";
  }

  // Check user in DB
  const user = await User.findOne({ username, password }).exec();
  if (!user) {
    return res
      .status(401)
      .json({ success: false, message: "Invalid credentials" });
  }

  // Store in session
  req.session.username = username;
  req.session.deviceType = deviceType;

  // Initialize connections for this user if not exist
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

  // Set up SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // Add to array
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

  // Set up SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  connections[username].phone.push(res);

  req.on("close", () => {
    connections[username].phone = connections[username].phone.filter(
      (client) => client !== res
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  CHAT-LIKE ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

// Send image from laptop -> phone (Image is in JSON body as base64Image)
app.post("/send-image", (req, res) => {
  const username = req.session.username;
  if (!username || req.session.deviceType !== "laptop") {
    return res.status(403).json({ message: "Forbidden" });
  }

  const { base64Image } = req.body;
  if (!base64Image) {
    return res
      .status(400)
      .json({ success:false, message: "No base64Image in the request body" });
  }
  const dataUri = `data:image/png;base64,${base64Image}`;

  // Broadcast to phone SSE clients
  broadcastToDeviceType(username, "phone", {
    type: "image",
    data: dataUri,
  });

  // Send success response
  res.json({ success: true, message: "Image sent successfully" });
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

app.get("/", (req, res) => {
  res.send("Welcome to the server!");
});

app.use((req, res) => {
  res.status(404).json({ success: false, message: "Not found" });
});

// ─────────────────────────────────────────────────────────────────────────────
//  START SERVER
// ─────────────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
