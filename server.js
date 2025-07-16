// Complete Anonymous Safety Backend with Firebase Cloud Messaging
// Updated with Category Support for Android App

const express = require('express');
const admin = require('firebase-admin');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Basic security
app.use(helmet());
app.use(cors());
app.use(express.json());

// Simple rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});
app.use(limiter);

// Category validation
const VALID_CATEGORIES = ['safety', 'fun', 'lost'];
const CATEGORY_ICONS = {
  'safety': '⚠️',
  'fun': '🎉',
  'lost': '🔍'
};

// Initialize Firebase Admin - Updated to read JSON file
let firebaseApp;
let messagingEnabled = false;

try {
  // Try to read Firebase service account JSON file
  const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_KEY || './firebase-service-account.json';
  
  if (fs.existsSync(serviceAccountPath)) {
    const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
    
    firebaseApp = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    
    messagingEnabled = true;
    console.log('🔥 Firebase Admin initialized successfully!');
    console.log(`📱 Project ID: ${serviceAccount.project_id}`);
    console.log('📨 Push notifications ENABLED');
    
  } else if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PRIVATE_KEY && process.env.FIREBASE_CLIENT_EMAIL) {
    // Fallback to environment variables
    const serviceAccount = {
      projectId: process.env.FIREBASE_PROJECT_ID,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    };
    
    firebaseApp = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    
    messagingEnabled = true;
    console.log('🔥 Firebase Admin initialized from environment variables!');
    console.log(`📱 Project ID: ${process.env.FIREBASE_PROJECT_ID}`);
    console.log('📨 Push notifications ENABLED');
    
  } else {
    console.log('⚠️  Firebase service account file not found at:', serviceAccountPath);
    console.log('⚠️  Firebase environment variables not found either');
    console.log('💡 Push notifications will be disabled');
  }
} catch (error) {
  console.error('❌ Firebase initialization failed:', error.message);
  console.log('💡 Push notifications will be disabled');
  messagingEnabled = false;
}

// In-memory storage (will add Redis later)
const reports = new Map();
const subscriptions = new Map(); // Store FCM subscriptions by zone
const REPORT_EXPIRY = 8 * 60 * 60 * 1000; // 8 hours

// Clean up expired reports
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  
  for (const [id, report] of reports.entries()) {
    if (report.expires < now) {
      reports.delete(id);
      cleaned++;
    }
  }
  
  if (cleaned > 0) {
    console.log(`🗑️ Cleaned up ${cleaned} expired reports`);
  }
}, 60 * 60 * 1000); // Clean every hour

// Utility functions
function anonymizeLocation(lat, lng) {
  // Add controlled noise for privacy (±100 meters)
  const noiseLat = lat + (Math.random() - 0.5) * 0.002;
  const noiseLng = lng + (Math.random() - 0.5) * 0.002;
  
  // Convert to zone (simplified geohash for testing)
  const zone = Math.floor(noiseLat * 1000).toString() + '_' + Math.floor(noiseLng * 1000).toString();
  
  return { zone, noiseLat, noiseLng };
}

function sanitizeContent(text) {
  if (!text) return '';
  
  let clean = text;
  // Remove phone numbers
  clean = clean.replace(/\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g, '[phone]');
  // Remove emails
  clean = clean.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, '[email]');
  // Remove potential addresses
  clean = clean.replace(/\b\d+\s+[A-Za-z\s]+(?:Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Lane|Ln|Boulevard|Blvd)\b/gi, '[address]');
  
  return clean.substring(0, 500); // Limit length
}

function validateCategory(category) {
  if (!category) return 'safety'; // Default to safety for backward compatibility
  
  // Normalize category
  const normalizedCategory = category.toLowerCase().trim();
  
  // Return valid category or default
  return VALID_CATEGORIES.includes(normalizedCategory) ? normalizedCategory : 'safety';
}

function getCategoryTitle(category) {
  const icon = CATEGORY_ICONS[category] || '⚠️';
  const titles = {
    'safety': 'Safety Alert',
    'fun': 'Event Alert', 
    'lost': 'Lost/Found Alert'
  };
  
  return `${icon} ${titles[category] || 'Safety Alert'}`;
}

function fuzzyTimestamp() {
  // Round to nearest 15 minutes for privacy
  const now = Date.now();
  const fifteenMinutes = 15 * 60 * 1000;
  return Math.floor(now / fifteenMinutes) * fifteenMinutes;
}

// Get adjacent zones for broader alert coverage
function getAdjacentZones(zone) {
  const zones = [zone]; // Always include the original zone
  
  // Parse the zone (format: "lat_lng")
  const parts = zone.split('_');
  if (parts.length === 2) {
    const baseLat = parseInt(parts[0]);
    const baseLng = parseInt(parts[1]);
    
    // Add adjacent zones (8 surrounding zones)
    for (let latOffset = -1; latOffset <= 1; latOffset++) {
      for (let lngOffset = -1; lngOffset <= 1; lngOffset++) {
        if (latOffset === 0 && lngOffset === 0) continue; // Skip the original zone
        
        const adjacentZone = `${baseLat + latOffset}_${baseLng + lngOffset}`;
        zones.push(adjacentZone);
      }
    }
  }
  
  return zones;
}

// Send push notification to Firebase Cloud Messaging
async function sendPushNotification(report, zones) {
  if (!messagingEnabled) {
    console.log('📨 Push notifications disabled (Firebase not configured)');
    return { success: false, reason: 'Firebase not configured' };
  }
  
  try {
    const notifications = [];
    const categoryTitle = getCategoryTitle(report.category);
    const categoryIcon = CATEGORY_ICONS[report.category] || '⚠️';
    
    // Send to each affected zone
    for (const zone of zones) {
      const topicName = `zone_${zone}`;
      
      const message = {
        topic: topicName,
        notification: {
          title: categoryTitle,
          body: `${categoryIcon} ${report.content.substring(0, 100)}${report.content.length > 100 ? '...' : ''}`
        },
        data: {
          reportId: report.id,
          zone: report.zone,
          category: report.category, // ← Include category in push data
          timestamp: report.timestamp.toString(),
          expires: report.expires.toString(),
          hasPhoto: report.hasPhoto.toString(),
          language: report.language
        },
        android: {
          priority: 'high',
          ttl: REPORT_EXPIRY, // Expire with the report
          notification: {
            sound: 'default',
            priority: 'high',
            channelId: 'safety_alerts',
            icon: 'ic_notification',
            color: report.category === 'safety' ? '#FF0000' : 
                   report.category === 'fun' ? '#FFD700' : '#2196F3'
          }
        }
      };
      
      try {
        const response = await admin.messaging().send(message);
        notifications.push({ zone, success: true, messageId: response });
        console.log(`📨 ${categoryIcon} Push notification sent to topic: ${topicName} (${report.category})`);
      } catch (error) {
        notifications.push({ zone, success: false, error: error.message });
        console.error(`❌ Failed to send notification to zone ${zone}:`, error.message);
      }
    }
    
    return { success: true, notifications };
    
  } catch (error) {
    console.error('❌ Push notification error:', error);
    return { success: false, error: error.message };
  }
}

// API Routes

// Health check
app.get('/health', (req, res) => {
  console.log('💓 Health check requested');
  
  // Count reports by category for stats
  const now = Date.now();
  const categoryStats = {};
  for (const category of VALID_CATEGORIES) {
    categoryStats[category] = 0;
  }
  
  for (const report of reports.values()) {
    if (report.expires > now) {
      categoryStats[report.category] = (categoryStats[report.category] || 0) + 1;
    }
  }
  
  res.json({ 
    status: 'OK', 
    timestamp: Date.now(),
    reports_count: reports.size,
    categories: categoryStats,
    valid_categories: VALID_CATEGORIES,
    server: 'Anonymous Safety Backend v1.1 (with Categories)',
    privacy: 'No user tracking enabled',
    firebase_enabled: messagingEnabled,
    push_notifications: messagingEnabled ? 'enabled' : 'disabled'
  });
});

// Submit report - UPDATED WITH CATEGORY SUPPORT
app.post('/report', async (req, res) => {
  try {
    const { lat, lng, content, language, hasPhoto, category } = req.body; // ← Added category
    
    console.log(`📝 New report request: lat=${lat}, lng=${lng}, category=${category}, content="${content?.substring(0, 30)}..."`);
    
    if (!lat || !lng || !content) {
      console.log('❌ Missing required fields');
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    // Validate and normalize category
    const validatedCategory = validateCategory(category);
    const categoryIcon = CATEGORY_ICONS[validatedCategory];
    
    // Anonymize location
    const location = anonymizeLocation(lat, lng);
    
    // Create anonymous report with category
    const report = {
      id: 'report_' + Math.random().toString(36).substring(2) + Date.now().toString(36),
      zone: location.zone,
      content: sanitizeContent(content),
      language: language || 'unknown',
      hasPhoto: Boolean(hasPhoto),
      category: validatedCategory, // ← Store validated category
      timestamp: fuzzyTimestamp(),
      expires: Date.now() + REPORT_EXPIRY
    };
    
    // Store report
    reports.set(report.id, report);
    
    console.log(`✅ ${categoryIcon} Report ${report.id} stored in zone ${report.zone}`);
    console.log(`📂 Category: ${validatedCategory} ${categoryIcon}`);
    console.log(`📋 Content: "${report.content}"`);
    console.log(`🌍 Zone: ${report.zone} (anonymized from ${lat}, ${lng})`);
    console.log(`⏰ Expires: ${new Date(report.expires).toLocaleString()}`);
    
    // Get affected zones (current + adjacent)
    const affectedZones = getAdjacentZones(location.zone);
    console.log(`📡 Broadcasting ${validatedCategory} alert to ${affectedZones.length} zones: ${affectedZones.join(', ')}`);
    
    // Send push notifications with category
    const pushResult = await sendPushNotification(report, affectedZones);
    
    console.log(`📊 Total reports: ${reports.size}`);
    
    res.json({
      success: true,
      reportId: report.id,
      zone: report.zone,
      category: report.category, // ← Include category in response
      categoryIcon: categoryIcon,
      timestamp: report.timestamp,
      expires: report.expires,
      affected_zones: affectedZones,
      push_notifications: pushResult,
      message: `${getCategoryTitle(validatedCategory)} submitted successfully`
    });
    
  } catch (error) {
    console.error('❌ Report submission error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get reports for a zone - UPDATED TO INCLUDE CATEGORY
app.get('/zone/:zoneId', (req, res) => {
  try {
    const { zoneId } = req.params;
    const { category } = req.query; // Optional category filter
    const now = Date.now();
    
    console.log(`🔍 Zone request for: ${zoneId}${category ? ` (category: ${category})` : ''}`);
    
    let zoneReports = Array.from(reports.values())
      .filter(report => report.zone === zoneId && report.expires > now);
    
    // Filter by category if specified
    if (category && VALID_CATEGORIES.includes(category.toLowerCase())) {
      zoneReports = zoneReports.filter(report => report.category === category.toLowerCase());
    }
    
    zoneReports = zoneReports
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 20) // Limit to 20 most recent
      .map(report => ({
        // Return only safe data with category
        id: report.id,
        zone: report.zone,
        content: report.content,
        language: report.language,
        hasPhoto: report.hasPhoto,
        category: report.category, // ← Include category in response
        categoryIcon: CATEGORY_ICONS[report.category],
        timestamp: report.timestamp,
        expires: report.expires
      }));
    
    console.log(`📊 Found ${zoneReports.length} reports for zone ${zoneId}${category ? ` (${category})` : ''}`);
    
    res.json({
      zone: zoneId,
      category_filter: category || 'all',
      reports: zoneReports,
      count: zoneReports.length,
      valid_categories: VALID_CATEGORIES,
      timestamp: Date.now()
    });
    
  } catch (error) {
    console.error('❌ Zone fetch error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Subscribe to zone notifications
app.post('/subscribe', async (req, res) => {
  try {
    const { lat, lng, platform, token, categories } = req.body; // ← Added optional categories filter
    
    console.log(`📱 Subscription request: platform=${platform}, lat=${lat}, lng=${lng}, categories=${categories}`);
    
    if (!lat || !lng) {
      return res.status(400).json({ error: 'Missing location' });
    }
    
    const location = anonymizeLocation(lat, lng);
    const affectedZones = getAdjacentZones(location.zone);
    
    let subscriptionResults = [];
    
    // Subscribe to FCM topics if Firebase is enabled and token provided
    if (messagingEnabled && token && platform === 'android') {
      for (const zone of affectedZones) {
        const topicName = `zone_${zone}`;
        
        try {
          await admin.messaging().subscribeToTopic([token], topicName);
          subscriptionResults.push({ zone, topic: topicName, success: true });
          console.log(`✅ Subscribed token to topic: ${topicName}`);
        } catch (error) {
          subscriptionResults.push({ zone, topic: topicName, success: false, error: error.message });
          console.error(`❌ Failed to subscribe to topic ${topicName}:`, error.message);
        }
      }
    } else {
      console.log(`📝 Subscription registered for zone ${location.zone} (FCM disabled or no token)`);
    }
    
    res.json({
      success: true,
      zone: location.zone,
      affected_zones: affectedZones,
      platform: platform,
      firebase_enabled: messagingEnabled,
      subscriptions: subscriptionResults,
      valid_categories: VALID_CATEGORIES, // ← Include valid categories
      message: messagingEnabled ? 'Subscribed to push notifications' : 'Subscription registered (push notifications disabled)',
      timestamp: Date.now()
    });
    
  } catch (error) {
    console.error('❌ Subscription error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// NEW: Get reports by category across all zones
app.get('/reports/category/:category', (req, res) => {
  try {
    const { category } = req.params;
    const now = Date.now();
    
    if (!VALID_CATEGORIES.includes(category.toLowerCase())) {
      return res.status(400).json({ 
        error: 'Invalid category', 
        valid_categories: VALID_CATEGORIES 
      });
    }
    
    const normalizedCategory = category.toLowerCase();
    console.log(`🔍 Category search for: ${normalizedCategory}`);
    
    const categoryReports = Array.from(reports.values())
      .filter(report => report.category === normalizedCategory && report.expires > now)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 50) // Limit to 50 most recent
      .map(report => ({
        id: report.id,
        zone: report.zone,
        content: report.content,
        language: report.language,
        hasPhoto: report.hasPhoto,
        category: report.category,
        categoryIcon: CATEGORY_ICONS[report.category],
        timestamp: report.timestamp,
        expires: report.expires
      }));
    
    console.log(`📊 Found ${categoryReports.length} ${normalizedCategory} reports`);
    
    res.json({
      category: normalizedCategory,
      categoryIcon: CATEGORY_ICONS[normalizedCategory],
      reports: categoryReports,
      count: categoryReports.length,
      timestamp: Date.now()
    });
    
  } catch (error) {
    console.error('❌ Category search error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get all zones with report counts (for debugging) - UPDATED WITH CATEGORY BREAKDOWN
app.get('/debug/zones', (req, res) => {
  try {
    const now = Date.now();
    const zones = {};
    const categoryBreakdown = {};
    
    // Initialize category breakdown
    for (const category of VALID_CATEGORIES) {
      categoryBreakdown[category] = 0;
    }
    
    for (const report of reports.values()) {
      if (report.expires > now) {
        // Zone counts
        zones[report.zone] = zones[report.zone] || { total: 0 };
        zones[report.zone].total++;
        zones[report.zone][report.category] = (zones[report.zone][report.category] || 0) + 1;
        
        // Global category breakdown
        categoryBreakdown[report.category]++;
      }
    }
    
    console.log(`🗺️ Debug zones request - Active zones: ${Object.keys(zones).length}`);
    
    res.json({
      zones,
      total_zones: Object.keys(zones).length,
      total_reports: Object.values(zones).reduce((acc, zone) => acc + zone.total, 0),
      category_breakdown: categoryBreakdown,
      valid_categories: VALID_CATEGORIES,
      category_icons: CATEGORY_ICONS,
      firebase_enabled: messagingEnabled,
      timestamp: Date.now()
    });
    
  } catch (error) {
    console.error('❌ Debug zones error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Start server
app.listen(PORT, () => {
  console.log('🚀 ================================');
  console.log(`🚀 Anonymous Safety Backend STARTED`);
  console.log(`🚀 ================================`);
  console.log(`📡 Server: http://localhost:${PORT}`);
  console.log(`💓 Health: http://localhost:${PORT}/health`);
  console.log(`🔐 Privacy: No user tracking enabled`);
  console.log(`⏰ Auto-delete: Reports expire in 8 hours`);
  console.log(`🔥 Firebase: ${messagingEnabled ? 'ENABLED' : 'DISABLED'}`);
  console.log(`📨 Push notifications: ${messagingEnabled ? 'ENABLED' : 'DISABLED'}`);
  console.log(`📂 Categories: ${VALID_CATEGORIES.join(', ')}`);
  console.log(`🧪 Debug: http://localhost:${PORT}/debug/zones`);
  console.log('🚀 ================================');
  
  if (messagingEnabled) {
    console.log('📱 Ready to send push notifications with categories!');
  } else {
    console.log('⚠️  Firebase service account file needed for push notifications');
    console.log('💡 Place firebase-service-account.json in the project folder');
  }
  
  console.log('📝 Ready to receive categorized anonymous reports!');
  console.log(`${CATEGORY_ICONS.safety} Safety | ${CATEGORY_ICONS.fun} Fun | ${CATEGORY_ICONS.lost} Lost/Found`);
  console.log('');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 Server shutting down...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('🛑 Server stopping...');
  process.exit(0);
});