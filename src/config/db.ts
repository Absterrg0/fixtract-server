// src/config/db.ts
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { ensureNonUniquePhoneIndex } from '../utils/ensureNonUniquePhoneIndex';

dotenv.config();

async function dropLegacyUniquePhoneIndex() {
  try {
    await ensureNonUniquePhoneIndex();
  } catch (error) {
    console.error('Failed to ensure non-unique phone index:', (error as Error).message);
  }
}

const connectDB = async () => {
  // Short-circuit: mongoose caches the connection and serializes concurrent connects,
  // so skip when already connected (1) or currently connecting (2).
  const state = mongoose.connection.readyState;
  if (state === mongoose.ConnectionStates.connected) {
    await dropLegacyUniquePhoneIndex();
    return;
  }
  if (state === mongoose.ConnectionStates.connecting) return;
  const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!mongoUri) {
    console.error('❌ MONGODB_URI or MONGO_URI is not defined in .env file');
    throw new Error('MONGODB_URI or MONGO_URI is not defined');
  }
  try {
    console.log('🟡 Connecting to MongoDB...');
    await mongoose.connect(mongoUri);
    console.log('✅ MongoDB connected successfully!');
    await dropLegacyUniquePhoneIndex();
  } catch (error) {
    console.error('❌ MongoDB connection error:', (error as Error).message);
    // Re-throw so request handlers can surface a 5xx response instead of the process exiting
    throw error;
  }
};

export default connectDB;
