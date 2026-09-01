import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import cookieParser from 'cookie-parser';

import authRoutes from './routes/authRoutes';
import userRoutes from './routes/userRoutes';
import roleRoutes from './routes/roleRoutes';
import appRoutes from './routes/appRoutes';
import dashboardRoutes from './routes/dashboardRoutes';
import activityRoutes from './routes/activityRoutes';
import notificationRoutes from './routes/notificationRoutes';
import rfqRoutes from './routes/rfqRoutes';

import { InboxService } from './services/inboxService';

import { connectDB } from './config/db';

dotenv.config();

// Initialize MongoDB Connection
connectDB().catch((err) => console.error('MongoDB Initialization Error:', err));

const app = express();
const PORT = process.env.PORT || 5000;

// Ensure DB connection is warm for Vercel serverless requests
app.use(async (req, res, next) => {
  if (req.path === '/health') return next();
  try {
    await connectDB();
    next();
  } catch (err: any) {
    res.status(500).json({ success: false, message: 'Database Connection Failed: ' + (err?.message || err) });
  }
});

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginEmbedderPolicy: false,
  })
);

const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3000',
  ...(process.env.FRONTEND_URL ? process.env.FRONTEND_URL.split(',').map((u) => u.trim()) : []),
];

const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    if (
      !origin ||
      allowedOrigins.some((allowed) => origin === allowed || origin.startsWith(allowed)) ||
      /\.vercel\.app$/.test(origin)
    ) {
      callback(null, true);
    } else {
      console.warn(`⚠️ CORS allowed origin fallback: ${origin}`);
      callback(null, true);
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
  exposedHeaders: ['Content-Disposition'],
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions) as any);
app.use(cookieParser());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// API Routes
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    service: 'Encon Command Center API Gateway',
    timestamp: new Date().toISOString(),
  });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/roles', roleRoutes);
app.use('/api/applications', appRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/activity', activityRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/rfq', rfqRoutes);


// Global Error Handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Unhandled Error:', err);
  res.status(500).json({
    success: false,
    message: err.message || 'Internal Server Error',
  });
});

if (require.main === module || !process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`🚀 Encon Command Center Server running on port ${PORT}`);
    console.log(`📡 Health Check: http://localhost:${PORT}/health`);

    // Background Inbox Poller (matches Python IMAP_POLL_SECONDS)
    const pollSecs = parseInt(process.env.IMAP_POLL_SECONDS || '300', 10);
    if (pollSecs > 0 && InboxService.isConfigured()) {
      console.log(`✉️ Email Inbox Poller active (syncing every ${pollSecs} seconds)`);
      setInterval(() => {
        InboxService.ingest().catch((err) => console.error('[Background Inbox Poller] Error:', err));
      }, pollSecs * 1000);
    }
  });
}

export default app;
