import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import admin from 'firebase-admin';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { ethers } from 'ethers';
import crypto from 'crypto';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Get current file directory for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load JSON file for ES modules
const enbMiniAppPath = join(__dirname, 'abis', 'EnbMiniApp.json');
const enbMiniApp = JSON.parse(readFileSync(enbMiniAppPath, 'utf8'));
const enbMiniAppAbi = enbMiniApp.abi;

// Load environment variables from .env
dotenv.config();

// === Firebase Initialization ===
if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  console.error('❌ FIREBASE_SERVICE_ACCOUNT_JSON not found. Exiting.');
  process.exit(1);
}

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);

// Only initialize Firebase if no app has been initialized
if (!getApps().length) {
  initializeApp({
    credential: cert(serviceAccount),
  });
}

const db = getFirestore();

// === Blockchain Setup ===
if (!process.env.RPC_URL || !process.env.PRIVATE_KEY || !process.env.CONTRACT_ADDRESS) {
  console.error('❌ Missing RPC_URL, PRIVATE_KEY, or CONTRACT_ADDRESS in .env');
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const relayerWallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
const contract = new ethers.Contract(process.env.CONTRACT_ADDRESS, enbMiniAppAbi, relayerWallet);

// === Express Setup ===
const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());

app.use(cors({
  origin: [
    'http://localhost:3000',
    'http://localhost:3001',
    'https://test-flight-six.vercel.app',
    'https://enb-crushers.vercel.app'
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
  exposedHeaders: ['Content-Length', 'Content-Type'],
  credentials: false,
  maxAge: 86400
}));

// === Helper Functions ===
const generateInvitationCode = () => crypto.randomBytes(4).toString('hex').toUpperCase();

const isInvitationCodeUnique = async (code) => {
  const snapshot = await db.collection('accounts')
    .where('invitationCode', '==', code)
    .limit(1)
    .get();
  return snapshot.empty;
};

const generateUniqueInvitationCode = async () => {
  let code;
  let attempts = 0;
  const maxAttempts = 10;

  do {
    code = generateInvitationCode();
    attempts++;
    if (attempts > maxAttempts) {
      throw new Error('Failed to generate unique invitation code after 10 attempts');
    }
  } while (!(await isInvitationCodeUnique(code)));

  return code;
};

// === Routes ===
// Basic route
app.get('/', (req, res) => {
  res.send('ENB API is running.');
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// Create user account
app.post('/api/create-account', async (req, res) => {
  console.log('📥 Incoming /api/create-account call');
  console.log('Request body:', req.body);

  const { walletAddress, transactionHash } = req.body;

  if (!walletAddress || !transactionHash) {
    console.warn('⚠️ Missing fields', { walletAddress, transactionHash });
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    console.log('Generating invitation code for:', walletAddress);
    const invitationCode = await generateUniqueInvitationCode();
    console.log('Generated invitation code:', invitationCode);

    await db.collection('accounts').doc(walletAddress).set({
      walletAddress,
      transactionHash,
      membershipLevel: 'Based',
      invitationCode,
      createdAt: new Date(),
      lastDailyClaimTime: null,
      consecutiveDays: 0,
      enbBalance: 0,
      totalEarned: 0,
      isActivated: false,
    });

    console.log('✅ Account created', { walletAddress, invitationCode });
    return res.status(201).json({ message: 'Account created successfully' });
  } catch (error) {
    console.error('❌ Error creating account for', walletAddress, error);
    return res.status(500).json({ error: 'Failed to create account' });
  }
});

// Create default user with limited invitation code
app.post('/api/create-default-user', async (req, res) => {
  const { walletAddress, invitationCode, maxUses } = req.body;

  if (!walletAddress || !invitationCode) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    // Check if invitation code already exists
    const existingCodeQuery = db.collection('accounts')
      .where('invitationCode', '==', invitationCode)
      .limit(1);
    const existingCodeSnapshot = await existingCodeQuery.get();

    if (!existingCodeSnapshot.empty) {
      return res.status(400).json({ error: 'Invitation code already exists' });
    }

    // Create the default user
    await db.collection('accounts').doc(walletAddress).set({
      walletAddress,
      membershipLevel: 'Based',
      invitationCode,
      maxInvitationUses: maxUses || 105, // Default to 105 uses
      currentInvitationUses: 0,
      createdAt: new Date(),
      lastDailyClaimTime: null,
      consecutiveDays: 0,
      enbBalance: 0,
      totalEarned: 0,
      isActivated: true, // Default user is activated
      activatedAt: new Date()
    });

    return res.status(201).json({ 
      message: 'Default user created successfully',
      invitationCode,
      maxUses: maxUses || 105
    });
  } catch (error) {
    console.error('Error creating default user:', error);
    return res.status(500).json({ error: 'Failed to create default user' });
  }
});

// Activate user account
app.post('/api/activate-account', async (req, res) => {
  const { walletAddress, invitationCode } = req.body;

  if (!walletAddress || !invitationCode) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    // Fetch user account
    const accountDoc = await db.collection('accounts').doc(walletAddress).get();

    if (!accountDoc.exists) {
      return res.status(404).json({ error: 'Account not found' });
    }

    const accountData = accountDoc.data();

    if (accountData.isActivated) {
      return res.status(400).json({ error: 'Account is already activated' });
    }

    // Find the user with the invitation code
    const invitationQuery = db.collection('accounts')
      .where('invitationCode', '==', invitationCode)
      .limit(1);
    const invitationSnapshot = await invitationQuery.get();

    if (invitationSnapshot.empty) {
      return res.status(400).json({ error: 'Invalid invitation code' });
    }

    const inviterDoc = invitationSnapshot.docs[0];
    const inviterData = inviterDoc.data();

    // Check if the inviter is activated
    if (!inviterData.isActivated) {
      return res.status(400).json({ error: 'Invitation code is from an inactive account' });
    }

    // Check if invitation code has reached its usage limit
    const maxUses = inviterData.maxInvitationUses || 5; // Default to 5 for regular users
    const currentUses = inviterData.currentInvitationUses || 0;

    if (currentUses >= maxUses) {
      return res.status(400).json({ error: 'Invitation code usage limit exceeded' });
    }

    // Check if this wallet has already used this invitation code
    const existingUsageQuery = db.collection('invitationUsage')
      .where('invitationCode', '==', invitationCode)
      .where('usedBy', '==', walletAddress)
      .limit(1);
    const existingUsageSnapshot = await existingUsageQuery.get();

    if (!existingUsageSnapshot.empty) {
      return res.status(400).json({ error: 'You have already used this invitation code' });
    }

    // Prepare usage log
    const usageLog = {
      invitationCode: invitationCode,
      usedBy: walletAddress,
      usedAt: new Date(),
      inviterWallet: inviterData.walletAddress
    };

    // Batch update
    const batch = db.batch();

    const accountRef = db.collection('accounts').doc(walletAddress);
    batch.update(accountRef, {
      isActivated: true,
      activatedAt: new Date(),
      activatedBy: invitationCode,
      inviterWallet: inviterData.walletAddress
    });

    // Update inviter's usage count
    const inviterRef = db.collection('accounts').doc(inviterData.walletAddress);
    batch.update(inviterRef, {
      currentInvitationUses: currentUses + 1
    });

    // Add usage log
    const usageRef = db.collection('invitationUsage').doc();
    batch.set(usageRef, usageLog);

    await batch.commit();

    return res.status(200).json({
      message: 'Account activated successfully',
      membershipLevel: accountData.membershipLevel || 'Based',
      inviterWallet: inviterData.walletAddress,
      remainingUses: maxUses - (currentUses + 1)
    });

  } catch (error) {
    console.error('Error activating account:', error);
    return res.status(500).json({ error: 'Failed to activate account' });
  }
});

app.get('/api/profile/:walletAddress', async (req, res) => {
  const walletAddress = req.params.walletAddress;
  
  console.log('📥 Incoming /api/profile call for wallet:', walletAddress);

  try {
    const doc = await db.collection('accounts').doc(walletAddress).get();

    if (!doc.exists) {
      console.log('❌ Account not found for wallet:', walletAddress);
      return res.status(404).json({ error: 'Account not found' });
    }

    const data = doc.data();
    
    // Get invitation usage data if user has an invitation code
    let invitationUsage = null;
    if (data.invitationCode) {
      const maxUses = data.maxInvitationUses || 5;
      const currentUses = data.currentInvitationUses || 0;
      
      invitationUsage = {
        totalUses: currentUses,
        maxUses: maxUses,
        remainingUses: maxUses - currentUses
      };
    }
    
    const profileData = {
      walletAddress: data.walletAddress,
      membershipLevel: data.membershipLevel || 'Based',
      invitationCode: data.invitationCode || null,
      invitationUsage: invitationUsage,
      enbBalance: data.enbBalance || 0,
      lastDailyClaimTime: data.lastDailyClaimTime && data.lastDailyClaimTime.toDate ? data.lastDailyClaimTime.toDate().toISOString() : (data.lastDailyClaimTime ? data.lastDailyClaimTime.toISOString() : null),
      consecutiveDays: data.consecutiveDays || 0,
      totalEarned: data.totalEarned || 0,
      isActivated: data.isActivated || false,
      activatedAt: data.activatedAt && data.activatedAt.toDate ? data.activatedAt.toDate().toISOString() : (data.activatedAt ? data.activatedAt.toISOString() : null),
      joinDate: data.createdAt && data.createdAt.toDate ? data.createdAt.toDate().toISOString() : (data.createdAt ? data.createdAt.toISOString() : null)
    };

    console.log('✅ Profile data retrieved for wallet:', walletAddress, { isActivated: data.isActivated, membershipLevel: data.membershipLevel });
    return res.status(200).json(profileData);
  } catch (error) {
    console.error('❌ Error fetching profile for wallet:', walletAddress, error);
    return res.status(500).json({ error: 'Failed to fetch profile' });
  }
});


// Updated: Daily claim with smart contract interaction via trusted relayer
app.post('/api/daily-claim', async (req, res) => {
  const { walletAddress } = req.body;

  if (!walletAddress || !ethers.isAddress(walletAddress)) {
    return res.status(400).json({ error: 'Missing or invalid wallet address' });
  }

  try {
    const accountRef = db.collection('accounts').doc(walletAddress);
    const accountDoc = await accountRef.get();

    if (!accountDoc.exists) {
      return res.status(404).json({ error: 'Account not found' });
    }

    const accountData = accountDoc.data();

    if (!accountData.isActivated) {
      return res.status(400).json({ error: 'Account is not activated' });
    }

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    // Check if user already claimed today
    if (accountData.lastDailyClaimTime) {
      const lastClaim = accountData.lastDailyClaimTime.toDate();
      const lastClaimDate = new Date(lastClaim.getFullYear(), lastClaim.getMonth(), lastClaim.getDate());

      if (lastClaimDate.getTime() === today.getTime()) {
        return res.status(400).json({ error: 'Already claimed today' });
      }
    }

    // Calculate streak & base reward
    let consecutiveDays = 1;
    let enbReward = 10;

    if (accountData.lastDailyClaimTime) {
      const lastClaim = accountData.lastDailyClaimTime.toDate();
      const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
      const lastClaimDate = new Date(lastClaim.getFullYear(), lastClaim.getMonth(), lastClaim.getDate());

      if (lastClaimDate.getTime() === yesterday.getTime()) {
        consecutiveDays = (accountData.consecutiveDays || 0) + 1;
        const multiplier = Math.min(consecutiveDays, 5);
        enbReward = 10 * multiplier;
      }
    }

    // Apply membership multiplier
    const membershipMultiplier = {
      'Based': 1,
      'Super Based': 1.5,
      'Legendary': 2
    };

    const finalReward = Math.floor(enbReward * (membershipMultiplier[accountData.membershipLevel] || 1));

    // === Trusted Relayer executes smart contract call ===
    const tx = await contract.dailyClaim(walletAddress);
    await tx.wait();

    // Update Firestore
    await accountRef.update({
      lastDailyClaimTime: now,
      consecutiveDays,
      enbBalance: (accountData.enbBalance || 0) + finalReward,
      totalEarned: (accountData.totalEarned || 0) + finalReward,
      lastTransactionHash: tx.hash
    });

    // Optional: Log claim
    await db.collection("claims").doc(walletAddress).set({
      claimedAt: now.toISOString(),
      reward: finalReward,
      consecutiveDays,
      txHash: tx.hash,
    });

    return res.status(200).json({
      message: 'Daily claim successful via relayer',
      reward: finalReward,
      txHash: tx.hash,
      newBalance: (accountData.enbBalance || 0) + finalReward,
      consecutiveDays
    });

  } catch (error) {
    console.error('Daily claim error:', error);
    return res.status(500).json({ error: 'Failed to process daily claim' });
  }
});

// Get daily claim status
// Daily claim functionality
app.post('/api/daily-claim', async (req, res) => {
  const { walletAddress, transactionHash } = req.body;

  if (!walletAddress || !transactionHash) {
    return res.status(400).json({ error: 'Missing wallet address or transaction hash' });
  }

  try {
    const accountRef = db.collection('accounts').doc(walletAddress);
    const accountDoc = await accountRef.get();

    if (!accountDoc.exists) {
      return res.status(404).json({ error: 'Account not found' });
    }

    const accountData = accountDoc.data();

    if (!accountData.isActivated) {
      return res.status(400).json({ error: 'Account is not activated' });
    }

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    // Check if user already claimed today
    if (accountData.lastDailyClaimTime) {
      const lastClaim = accountData.lastDailyClaimTime.toDate();
      const lastClaimDate = new Date(lastClaim.getFullYear(), lastClaim.getMonth(), lastClaim.getDate());

      if (lastClaimDate.getTime() === today.getTime()) {
        return res.status(400).json({ error: 'Already claimed today' });
      }
    }

    // Calculate consecutive days and rewards
    let consecutiveDays = 1;
    let enbReward = 10; // Base reward

    if (accountData.lastDailyClaimTime) {
      const lastClaim = accountData.lastDailyClaimTime.toDate();
      const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
      const lastClaimDate = new Date(lastClaim.getFullYear(), lastClaim.getMonth(), lastClaim.getDate());

      if (lastClaimDate.getTime() === yesterday.getTime()) {
        consecutiveDays = (accountData.consecutiveDays || 0) + 1;
        const multiplier = Math.min(consecutiveDays, 5);
        enbReward = 10 * multiplier;
      }
    }

    // Membership level bonuses
    const membershipMultiplier = {
      'Based': 1,
      'Super Based': 1.5,
      'Legendary': 2
    };

    const finalReward = Math.floor(enbReward * (membershipMultiplier[accountData.membershipLevel] || 1));

    // Update account with claim info
    await accountRef.update({
      lastDailyClaimTime: now,
      consecutiveDays: consecutiveDays,
      enbBalance: (accountData.enbBalance || 0) + finalReward,
      totalEarned: (accountData.totalEarned || 0) + finalReward,
      lastTransactionHash: transactionHash
    });

    return res.status(200).json({
      message: 'Daily claim successful',
      reward: finalReward,
      consecutiveDays: consecutiveDays,
      newBalance: (accountData.enbBalance || 0) + finalReward
    });

  } catch (error) {
    console.error('Error during daily claim:', error);
    return res.status(500).json({ error: 'Failed to process daily claim' });
  }
});


// Update ENB balance (for transactions)

app.post('/api/update-balance', async (req, res) => {
  const { walletAddress, amount, type, description } = req.body;

  if (!walletAddress || amount === undefined || !type) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  if (!['credit', 'debit'].includes(type)) {
    return res.status(400).json({ error: 'Invalid transaction type' });
  }

  try {
    const accountRef = db.collection('accounts').doc(walletAddress);
    const accountDoc = await accountRef.get();

    if (!accountDoc.exists) {
      return res.status(404).json({ error: 'Account not found' });
    }

    const accountData = accountDoc.data();
    const currentBalance = accountData.enbBalance || 0;
    const transactionAmount = parseFloat(amount);

    // Calculate new balance
    let newBalance;
    if (type === 'credit') {
      newBalance = currentBalance + transactionAmount;
    } else {
      if (currentBalance < transactionAmount) {
        return res.status(400).json({ error: 'Insufficient balance' });
      }
      newBalance = currentBalance - transactionAmount;
    }

    // Create transaction record
    const transactionData = {
      walletAddress,
      amount: transactionAmount,
      type,
      description: description || '',
      balanceBefore: currentBalance,
      balanceAfter: newBalance,
      timestamp: new Date()
    };

    // Batch update
    const batch = db.batch();
    
    // Update account balance
    batch.update(accountRef, { enbBalance: newBalance });
    
    // Add transaction record
    const transactionRef = db.collection('transactions').doc();
    batch.set(transactionRef, transactionData);

    await batch.commit();

    return res.status(200).json({
      message: 'Balance updated successfully',
      previousBalance: currentBalance,
      newBalance: newBalance,
      transactionId: transactionRef.id
    });

  } catch (error) {
    console.error('Error updating balance:', error);
    return res.status(500).json({ error: 'Failed to update balance' });
  }
});

// Get transaction history
app.get('/api/transactions/:walletAddress', async (req, res) => {
  const walletAddress = req.params.walletAddress;
  const limit = parseInt(req.query.limit) || 50;

  try {
    const transactionsQuery = db.collection('transactions')
      .where('walletAddress', '==', walletAddress)
      .orderBy('timestamp', 'desc')
      .limit(limit);

    const snapshot = await transactionsQuery.get();
    const transactions = [];

    snapshot.forEach(doc => {
      transactions.push({
        id: doc.id,
        ...doc.data(),
        timestamp: doc.data().timestamp.toISOString()
      });
    });

    return res.status(200).json({ transactions });

  } catch (error) {
    console.error('Error fetching transactions:', error);
    return res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

// Leaderboard - Top ENB Balance
app.get('/api/leaderboard/balance', async (req, res) => {
  const limit = parseInt(req.query.limit) || 50;

  try {
    const leaderboardQuery = db.collection('accounts')
      .where('isActivated', '==', true)
      .orderBy('enbBalance', 'desc')
      .limit(limit);

    const snapshot = await leaderboardQuery.get();
    const leaderboard = [];

    snapshot.forEach((doc, index) => {
      const data = doc.data();
      leaderboard.push({
        rank: index + 1,
        walletAddress: data.walletAddress,
        enbBalance: data.enbBalance || 0,
        membershipLevel: data.membershipLevel || 'Based',
        consecutiveDays: data.consecutiveDays || 0
      });
    });

    return res.status(200).json({ leaderboard });

  } catch (error) {
    console.error('Error fetching balance leaderboard:', error);
    return res.status(500).json({ error: 'Failed to fetch leaderboard' });
  }
});

// Leaderboard - Top Total Earned
app.get('/api/leaderboard/earnings', async (req, res) => {
  const limit = parseInt(req.query.limit) || 50;

  try {
    const leaderboardQuery = db.collection('accounts')
      .where('isActivated', '==', true)
      .orderBy('totalEarned', 'desc')
      .limit(limit);

    const snapshot = await leaderboardQuery.get();
    const leaderboard = [];

    snapshot.forEach((doc, index) => {
      const data = doc.data();
      leaderboard.push({
        rank: index + 1,
        walletAddress: data.walletAddress,
        totalEarned: data.totalEarned || 0,
        membershipLevel: data.membershipLevel || 'Based',
        consecutiveDays: data.consecutiveDays || 0
      });
    });

    return res.status(200).json({ leaderboard });

  } catch (error) {
    console.error('Error fetching earnings leaderboard:', error);
    return res.status(500).json({ error: 'Failed to fetch leaderboard' });
  }
});

// Leaderboard - Top Consecutive Days
app.get('/api/leaderboard/streaks', async (req, res) => {
  const limit = parseInt(req.query.limit) || 50;

  try {
    const leaderboardQuery = db.collection('accounts')
      .where('isActivated', '==', true)
      .orderBy('consecutiveDays', 'desc')
      .limit(limit);

    const snapshot = await leaderboardQuery.get();
    const leaderboard = [];

    snapshot.forEach((doc, index) => {
      const data = doc.data();
      leaderboard.push({
        rank: index + 1,
        walletAddress: data.walletAddress,
        consecutiveDays: data.consecutiveDays || 0,
        membershipLevel: data.membershipLevel || 'Based',
        enbBalance: data.enbBalance || 0
      });
    });

    return res.status(200).json({ leaderboard });

  } catch (error) {
    console.error('Error fetching streaks leaderboard:', error);
    return res.status(500).json({ error: 'Failed to fetch leaderboard' });
  }
});

// Get user ranking across all leaderboards
app.get('/api/user-rankings/:walletAddress', async (req, res) => {
  const walletAddress = req.params.walletAddress;

  try {
    const accountDoc = await db.collection('accounts').doc(walletAddress).get();

    if (!accountDoc.exists) {
      return res.status(404).json({ error: 'Account not found' });
    }

    const accountData = accountDoc.data();

    if (!accountData.isActivated) {
      return res.status(400).json({ error: 'Account is not activated' });
    }

    // Get balance ranking
    const balanceQuery = db.collection('accounts')
      .where('isActivated', '==', true)
      .where('enbBalance', '>', accountData.enbBalance || 0);
    const balanceSnapshot = await balanceQuery.get();
    const balanceRank = balanceSnapshot.size + 1;

    // Get earnings ranking
    const earningsQuery = db.collection('accounts')
      .where('isActivated', '==', true)
      .where('totalEarned', '>', accountData.totalEarned || 0);
    const earningsSnapshot = await earningsQuery.get();
    const earningsRank = earningsSnapshot.size + 1;

    // Get streak ranking
    const streakQuery = db.collection('accounts')
      .where('isActivated', '==', true)
      .where('consecutiveDays', '>', accountData.consecutiveDays || 0);
    const streakSnapshot = await streakQuery.get();
    const streakRank = streakSnapshot.size + 1;

    return res.status(200).json({
      walletAddress,
      rankings: {
        balance: {
          rank: balanceRank,
          value: accountData.enbBalance || 0
        },
        earnings: {
          rank: earningsRank,
          value: accountData.totalEarned || 0
        },
        streak: {
          rank: streakRank,
          value: accountData.consecutiveDays || 0
        }
      }
    });

  } catch (error) {
    console.error('Error fetching user rankings:', error);
    return res.status(500).json({ error: 'Failed to fetch user rankings' });
  }
});

// Get all users
app.get('/api/users', async (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const offset = parseInt(req.query.offset) || 0;
  const membershipLevel = req.query.membershipLevel;
  const isActivated = req.query.isActivated;

  try {
    let query = db.collection('accounts');

    // Apply filters if provided
    if (membershipLevel) {
      query = query.where('membershipLevel', '==', membershipLevel);
    }
    
    if (isActivated !== undefined) {
      query = query.where('isActivated', '==', isActivated === 'true');
    }

    // Apply ordering and pagination
    query = query.orderBy('createdAt', 'desc').limit(limit).offset(offset);

    const snapshot = await query.get();
    const users = [];

    snapshot.forEach(doc => {
      const data = doc.data();
      
      users.push({
        id: doc.id,
        walletAddress: data.walletAddress,
        membershipLevel: data.membershipLevel || 'Based',
        invitationCode: data.invitationCode || null,
        maxInvitationUses: data.maxInvitationUses || 5,
        currentInvitationUses: data.currentInvitationUses || 0,
        enbBalance: data.enbBalance || 0,
        totalEarned: data.totalEarned || 0,
        consecutiveDays: data.consecutiveDays || 0,
        isActivated: data.isActivated || false,
        createdAt: data.createdAt && data.createdAt.toDate ? data.createdAt.toDate().toISOString() : (data.createdAt ? data.createdAt.toISOString() : null),
        activatedAt: data.activatedAt && data.activatedAt.toDate ? data.activatedAt.toDate().toISOString() : (data.activatedAt ? data.activatedAt.toISOString() : null),
        lastDailyClaimTime: data.lastDailyClaimTime && data.lastDailyClaimTime.toDate ? data.lastDailyClaimTime.toDate().toISOString() : (data.lastDailyClaimTime ? data.lastDailyClaimTime.toISOString() : null)
      });
    });

    // Get total count for pagination info
    const totalQuery = db.collection('accounts');
    let totalSnapshot;
    
    if (membershipLevel || isActivated !== undefined) {
      let countQuery = db.collection('accounts');
      if (membershipLevel) {
        countQuery = countQuery.where('membershipLevel', '==', membershipLevel);
      }
      if (isActivated !== undefined) {
        countQuery = countQuery.where('isActivated', '==', isActivated === 'true');
      }
      totalSnapshot = await countQuery.get();
    } else {
      totalSnapshot = await totalQuery.get();
    }

    return res.status(200).json({
      users,
      pagination: {
        total: totalSnapshot.size,
        limit,
        offset,
        hasMore: users.length === limit
      }
    });

  } catch (error) {
    console.error('Error fetching users:', error);
    return res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Updated: Membership upgrade via smart contract relayer
app.post('/api/update-membership', async (req, res) => {
  const { walletAddress, membershipLevel } = req.body;

  if (!walletAddress || !ethers.isAddress(walletAddress) || !membershipLevel) {
    return res.status(400).json({ error: 'Missing or invalid input fields' });
  }

  // Validate membership level
  const levelMapping = {
    'Based': 0,
    'Super Based': 1,
    'Legendary': 2
  };

  if (!(membershipLevel in levelMapping)) {
    return res.status(400).json({ error: 'Invalid membership level' });
  }

  const targetLevel = levelMapping[membershipLevel];

  try {
    const accountRef = db.collection('accounts').doc(walletAddress);
    const accountDoc = await accountRef.get();

    if (!accountDoc.exists) {
      return res.status(404).json({ error: 'Account not found' });
    }

    const accountData = accountDoc.data();

    if (!accountData.isActivated) {
      return res.status(400).json({ error: 'Account is not activated' });
    }

    // Call upgradeMembership onchain using relayer
    const tx = await contract.upgradeMembership(walletAddress, targetLevel);
    await tx.wait();

    // Update Firestore
    await accountRef.update({
      membershipLevel: membershipLevel,
      lastUpgradeAt: new Date(),
      upgradeTransactionHash: tx.hash
    });

    // Optional log
    await db.collection("upgrades").doc(walletAddress).set({
      upgradedAt: new Date().toISOString(),
      level: targetLevel,
      txHash: tx.hash
    });

    return res.status(200).json({
      message: 'Membership level upgraded via relayer',
      newLevel: membershipLevel,
      txHash: tx.hash
    });

  } catch (error) {
    console.error('Error upgrading membership level:', error);
    return res.status(500).json({ error: 'Failed to upgrade membership level' });
  }
});


// Get invitation code usage count
app.get('/api/invitation-usage/:invitationCode', async (req, res) => {
  const invitationCode = req.params.invitationCode;

  if (!invitationCode) {
    return res.status(400).json({ error: 'Invitation code is required' });
  }

  try {
    // Get the inviter's account to check max uses
    const inviterQuery = db.collection('accounts')
      .where('invitationCode', '==', invitationCode)
      .limit(1);
    const inviterSnapshot = await inviterQuery.get();

    if (inviterSnapshot.empty) {
      return res.status(404).json({ error: 'Invitation code not found' });
    }

    const inviterData = inviterSnapshot.docs[0].data();
    const maxUses = inviterData.maxInvitationUses || 5;
    const currentUses = inviterData.currentInvitationUses || 0;

    // Get detailed usage history
    const usageQuery = db.collection('invitationUsage')
      .where('invitationCode', '==', invitationCode)
      .orderBy('usedAt', 'desc');
    const usageSnapshot = await usageQuery.get();
    
    const usageHistory = [];
    usageSnapshot.forEach(doc => {
      const data = doc.data();
      usageHistory.push({
        id: doc.id,
        usedBy: data.usedBy,
        usedAt: data.usedAt.toISOString(),
        inviterWallet: data.inviterWallet
      });
    });

    return res.status(200).json({
      invitationCode,
      totalUses: currentUses,
      maxUses: maxUses,
      remainingUses: maxUses - currentUses,
      usageHistory: usageHistory,
      inviterWallet: inviterData.walletAddress,
      isInviterActivated: inviterData.isActivated || false
    });

  } catch (error) {
    console.error('Error fetching invitation usage:', error);
    return res.status(500).json({ error: 'Failed to fetch invitation usage' });
  }
});


// === Trusted Relayer Routes ===

// Relayed daily claim via smart contract
app.post('/relay/daily-claim', async (req, res) => {
  const { user } = req.body;

  if (!user || !ethers.isAddress(user)) {
    return res.status(400).json({ error: 'Invalid user address' });
  }

  try {
    const tx = await contract.dailyClaim(user);
    await tx.wait();

    await db.collection("claims").doc(user).set({
      lastClaimed: new Date().toISOString(),
      txHash: tx.hash,
    });

    res.json({ success: true, txHash: tx.hash });
  } catch (err) {
    console.error("Relay daily claim error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Relayed membership upgrade via smart contract
app.post('/relay/upgrade-membership', async (req, res) => {
  const { user, targetLevel } = req.body;

  if (!user || !ethers.isAddress(user)) {
    return res.status(400).json({ error: 'Invalid user address' });
  }

  if (![1, 2].includes(targetLevel)) {
    return res.status(400).json({ error: 'Invalid membership level (must be 1 or 2)' });
  }

  try {
    const tx = await contract.upgradeMembership(user, targetLevel);
    await tx.wait();

    await db.collection("upgrades").doc(user).set({
      upgradedAt: new Date().toISOString(),
      level: targetLevel,
      txHash: tx.hash,
    });

    res.json({ success: true, txHash: tx.hash });
  } catch (err) {
    console.error("Relay upgrade error:", err);
    res.status(500).json({ error: err.message });
  }
});


// === Start Server ===
app.listen(PORT, () => {
  console.log(`🚀 Server is running on http://localhost:${PORT}`);
});
