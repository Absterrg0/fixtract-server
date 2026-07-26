import mongoose from "mongoose";
import dotenv from "dotenv";
import User from "../../models/user";
import { deleteUserData } from "../../utils/deleteUserData";

dotenv.config();

async function deleteUserByEmail(email: string) {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    throw new Error("MONGODB_URI not found in .env");
  }

  await mongoose.connect(mongoUri);

  const normalizedEmail = email.toLowerCase().trim();
  const user = await User.findOne({ email: normalizedEmail });
  if (!user) {
    console.error(`User not found with email: ${normalizedEmail}`);
    await mongoose.disconnect();
    process.exit(1);
  }

  await deleteUserData(user._id);
  await mongoose.disconnect();
}

const email = process.argv[2];
if (!email) {
  console.error("Usage: npm run delete:user -- <email>");
  process.exit(1);
}

deleteUserByEmail(email).catch(async (err) => {
  console.error("Error:", err);
  await mongoose.disconnect();
  process.exit(1);
});
