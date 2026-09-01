import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

let cached = (global as any).mongoose;

if (!cached) {
  cached = (global as any).mongoose = { conn: null, promise: null };
}

export async function connectDB(): Promise<typeof mongoose> {
  if (cached.conn && mongoose.connection.readyState === 1) {
    return cached.conn;
  }

  if (!cached.promise) {
    const mongoUri = (process.env.MONGODB_URI || process.env.DATABASE_URL || '').trim();

    if (!mongoUri || mongoUri.includes('127.0.0.1') || mongoUri.includes('localhost')) {
      if (process.env.VERCEL || process.env.NODE_ENV === 'production') {
        const err = new Error(
          'Missing MONGODB_URI on Vercel production! Add MONGODB_URI with your MongoDB Atlas connection string in Vercel Settings -> Environment Variables.'
        );
        console.error('❌', err.message);
        throw err;
      }
    }

    const uriToUse = mongoUri || 'mongodb://127.0.0.1:27017/encon_admin';

    const opts = {
      maxPoolSize: 10,
      minPoolSize: 1,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 30000,
      connectTimeoutMS: 5000,
    };

    cached.promise = mongoose.connect(uriToUse, opts).then((m) => m);
  }

  try {
    cached.conn = await cached.promise;
    return cached.conn;
  } catch (error: any) {
    cached.promise = null;
    console.error('❌ MongoDB Connection Error:', error.message);
    throw error;
  }
}

export default mongoose;
