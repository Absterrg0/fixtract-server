import mongoose from 'mongoose';
import bcrypt from 'bcrypt';
import User from '../../models/user';
import LoyaltyConfig from '../../models/loyaltyConfig';
import connectDB from '../../config/db';

const seedAdmin = async () => {
  try {
    console.log('🌱 Starting admin seed process...');

    // Connect to database
    await connectDB();
    console.log('✅ Connected to database');

    // Check if admin already exists
    const existingAdmin = await User.findOne({ role: 'admin' });
    
    if (existingAdmin) {
      console.log('⚠️ Admin user already exists:');
      console.log(`   Email: ${existingAdmin.email}`);
      console.log(`   Name: ${existingAdmin.name}`);
      console.log('   Use this account to login to admin panel');
      process.exit(0);
    }

    const initialEmail = process.env.INITIAL_ADMIN_EMAIL?.trim().toLowerCase();
    const initialPassword = process.env.INITIAL_ADMIN_PASSWORD;
    const initialPhone = process.env.INITIAL_ADMIN_PHONE?.trim();
    if (!initialEmail || !initialPassword || !initialPhone) {
      throw new Error(
        'INITIAL_ADMIN_EMAIL, INITIAL_ADMIN_PASSWORD, and INITIAL_ADMIN_PHONE are required',
      );
    }
    if (initialPassword.length < 12) {
      throw new Error('INITIAL_ADMIN_PASSWORD must be at least 12 characters');
    }

    const adminData = {
      name: 'Fixtract Admin',
      email: initialEmail,
      phone: initialPhone,
      password: initialPassword,
      role: 'admin',
      adminRole: 'super',
      accountStatus: 'active',
      isEmailVerified: true,
      isPhoneVerified: true
    };

    // Hash password
    const saltRounds = 12;
    const hashedPassword = await bcrypt.hash(adminData.password, saltRounds);

    // Create admin user
    const admin = new User({
      ...adminData,
      password: hashedPassword
    });

    await admin.save();

    console.log('🎉 Admin user created successfully!');
    console.log('');
    console.log(`📋 Admin email: ${initialEmail}`);
    console.log('');
    console.log('🚀 Admin can now access:');
    console.log('   • Professional approvals');
    console.log('   • Loyalty system configuration');
    console.log('   • System analytics');
    console.log('');

    // Also create loyalty configuration if it doesn't exist
    await LoyaltyConfig.getCurrentConfig();
    console.log('✅ Loyalty system initialized with default configuration');

    process.exit(0);

  } catch (error) {
    console.error('❌ Error creating admin user:', error);
    process.exit(1);
  }
};

// Run if called directly
if (require.main === module) {
  seedAdmin();
}

export default seedAdmin;
