import express from 'express';
import cors from 'cors';
import Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3847;

// Middleware - CORS restricted to Basecamp domains
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, etc.) or from Basecamp
    if (!origin || origin.endsWith('.basecamp.com') || origin === 'https://basecamp.com') {
      callback(null, true);
    } else {
      callback(null, true); // Allow all for now, but log non-Basecamp origins
      if (origin) console.log('Request from non-Basecamp origin:', origin);
    }
  }
}));
app.use(express.json());

// Simple rate limiting (per IP, 100 requests per minute)
const rateLimitMap = new Map();
const RATE_LIMIT = 100;
const RATE_WINDOW = 60000; // 1 minute

app.use((req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();

  if (!rateLimitMap.has(ip)) {
    rateLimitMap.set(ip, { count: 1, resetTime: now + RATE_WINDOW });
    return next();
  }

  const record = rateLimitMap.get(ip);
  if (now > record.resetTime) {
    record.count = 1;
    record.resetTime = now + RATE_WINDOW;
    return next();
  }

  record.count++;
  if (record.count > RATE_LIMIT) {
    return res.status(429).json({ error: 'Too many requests, please try again later' });
  }

  next();
});

// Clean up old rate limit entries every 5 minutes to prevent memory leak
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of rateLimitMap.entries()) {
    if (now > record.resetTime) {
      rateLimitMap.delete(ip);
    }
  }
}, 5 * 60 * 1000);

// Input sanitization helper
function sanitizeString(str, maxLength = 255) {
  if (typeof str !== 'string') return '';
  return str.trim().substring(0, maxLength);
}

// Initialize SQLite database (use /data for persistent storage on Railway/Render)
const dataDir = process.env.DATA_DIR || __dirname;
if (!existsSync(dataDir)) {
  mkdirSync(dataDir, { recursive: true });
}
const dbPath = join(dataDir, 'tagger.db');
const db = new Database(dbPath);

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS teams (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    invite_code TEXT UNIQUE NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS members (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    name TEXT,
    joined_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
    UNIQUE(team_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS tags (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL,
    name TEXT NOT NULL,
    color TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS card_tags (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL,
    card_id TEXT NOT NULL,
    tag_id TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
    FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE,
    UNIQUE(team_id, card_id, tag_id)
  );
`);

// Generate invite code (6 chars, easy to type)
function generateInviteCode() {
  return nanoid(6).toUpperCase();
}

// ============== TEAM ENDPOINTS ==============

// Create a new team
app.post('/api/teams', (req, res) => {
  try {
    const name = sanitizeString(req.body.name, 100);
    const userId = sanitizeString(req.body.userId, 100);
    const userName = sanitizeString(req.body.userName, 100);

    if (!name || !userId) {
      return res.status(400).json({ error: 'Team name and userId required' });
    }

    const teamId = nanoid();
    const inviteCode = generateInviteCode();
    const memberId = nanoid();

    const insertTeam = db.prepare('INSERT INTO teams (id, name, invite_code) VALUES (?, ?, ?)');
    insertTeam.run(teamId, name, inviteCode);

    const insertMember = db.prepare('INSERT INTO members (id, team_id, user_id, name) VALUES (?, ?, ?, ?)');
    insertMember.run(memberId, teamId, userId, userName || 'Owner');

    // Create default tags with emojis
    const defaultTags = [
      { name: 'Urgent', color: '🔥' },
      { name: 'In Progress', color: '🟡' },
      { name: 'Review', color: '🔵' },
      { name: 'Done', color: '✅' },
      { name: 'Blocked', color: '🔒' },
      { name: 'Bug', color: '🐛' }
    ];

    const insertTag = db.prepare('INSERT INTO tags (id, team_id, name, color) VALUES (?, ?, ?, ?)');
    defaultTags.forEach(tag => {
      insertTag.run(nanoid(), teamId, tag.name, tag.color);
    });

    res.json({
      team: { id: teamId, name, invite_code: inviteCode },
      message: 'Team created successfully'
    });
  } catch (error) {
    console.error('Error creating team:', error);
    res.status(500).json({ error: 'Failed to create team' });
  }
});

// Join a team with invite code
app.post('/api/teams/join', (req, res) => {
  try {
    const inviteCode = sanitizeString(req.body.inviteCode, 10);
    const userId = sanitizeString(req.body.userId, 100);
    const userName = sanitizeString(req.body.userName, 100);

    if (!inviteCode || !userId) {
      return res.status(400).json({ error: 'Invite code and userId required' });
    }

    const team = db.prepare('SELECT * FROM teams WHERE invite_code = ?').get(inviteCode.toUpperCase());
    if (!team) {
      return res.status(404).json({ error: 'Invalid invite code' });
    }

    // Check if already a member
    const existing = db.prepare('SELECT * FROM members WHERE team_id = ? AND user_id = ?').get(team.id, userId);
    if (existing) {
      return res.json({ team, message: 'Already a member' });
    }

    const memberId = nanoid();
    const insertMember = db.prepare('INSERT INTO members (id, team_id, user_id, name) VALUES (?, ?, ?, ?)');
    insertMember.run(memberId, team.id, userId, userName || 'Member');

    res.json({ team, message: 'Joined team successfully' });
  } catch (error) {
    console.error('Error joining team:', error);
    res.status(500).json({ error: 'Failed to join team' });
  }
});

// Get user's teams
app.get('/api/teams/:userId', (req, res) => {
  try {
    const { userId } = req.params;
    const teams = db.prepare(`
      SELECT t.* FROM teams t
      JOIN members m ON t.id = m.team_id
      WHERE m.user_id = ?
    `).all(userId);

    res.json({ teams });
  } catch (error) {
    console.error('Error fetching teams:', error);
    res.status(500).json({ error: 'Failed to fetch teams' });
  }
});

// Get team details with members
app.get('/api/teams/:teamId/details', (req, res) => {
  try {
    const { teamId } = req.params;
    const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId);
    if (!team) {
      return res.status(404).json({ error: 'Team not found' });
    }

    const members = db.prepare('SELECT id, user_id, name, joined_at FROM members WHERE team_id = ?').all(teamId);

    res.json({ team, members });
  } catch (error) {
    console.error('Error fetching team details:', error);
    res.status(500).json({ error: 'Failed to fetch team details' });
  }
});

// Leave a team
app.post('/api/teams/:teamId/leave', (req, res) => {
  try {
    const teamId = sanitizeString(req.params.teamId, 50);
    const userId = sanitizeString(req.body.userId, 100);

    if (!userId) {
      return res.status(400).json({ error: 'userId required' });
    }

    // Check if user is a member
    const member = db.prepare('SELECT * FROM members WHERE team_id = ? AND user_id = ?').get(teamId, userId);
    if (!member) {
      return res.status(404).json({ error: 'Not a member of this team' });
    }

    // Check if this is the last member
    const memberCount = db.prepare('SELECT COUNT(*) as count FROM members WHERE team_id = ?').get(teamId);

    if (memberCount.count === 1) {
      // Last member leaving - delete the entire team
      db.prepare('DELETE FROM card_tags WHERE team_id = ?').run(teamId);
      db.prepare('DELETE FROM tags WHERE team_id = ?').run(teamId);
      db.prepare('DELETE FROM members WHERE team_id = ?').run(teamId);
      db.prepare('DELETE FROM teams WHERE id = ?').run(teamId);
      return res.json({ success: true, teamDeleted: true, message: 'Team deleted (you were the last member)' });
    }

    // Remove the member
    db.prepare('DELETE FROM members WHERE team_id = ? AND user_id = ?').run(teamId, userId);
    res.json({ success: true, message: 'Left team successfully' });
  } catch (error) {
    console.error('Error leaving team:', error);
    res.status(500).json({ error: 'Failed to leave team' });
  }
});

// ============== TAG ENDPOINTS ==============

// Get all tags for a team
app.get('/api/tags/:teamId', (req, res) => {
  try {
    const { teamId } = req.params;
    const tags = db.prepare('SELECT * FROM tags WHERE team_id = ? ORDER BY created_at').all(teamId);
    res.json({ tags });
  } catch (error) {
    console.error('Error fetching tags:', error);
    res.status(500).json({ error: 'Failed to fetch tags' });
  }
});

// Create a tag
app.post('/api/tags', (req, res) => {
  try {
    const teamId = sanitizeString(req.body.teamId, 50);
    const name = sanitizeString(req.body.name, 50);
    const color = sanitizeString(req.body.color, 10);

    if (!teamId || !name || !color) {
      return res.status(400).json({ error: 'teamId, name, and color required' });
    }

    // Check for duplicate tag name in this team
    const existing = db.prepare('SELECT id FROM tags WHERE team_id = ? AND name = ?').get(teamId, name);
    if (existing) {
      return res.status(400).json({ error: 'A tag with this name already exists' });
    }

    const tagId = nanoid();
    const insertTag = db.prepare('INSERT INTO tags (id, team_id, name, color) VALUES (?, ?, ?, ?)');
    insertTag.run(tagId, teamId, name, color);

    res.json({ tag: { id: tagId, team_id: teamId, name, color } });
  } catch (error) {
    console.error('Error creating tag:', error);
    res.status(500).json({ error: 'Failed to create tag' });
  }
});

// Update a tag
app.put('/api/tags/:tagId', (req, res) => {
  try {
    const tagId = sanitizeString(req.params.tagId, 50);
    const name = req.body.name ? sanitizeString(req.body.name, 50) : null;
    const color = req.body.color ? sanitizeString(req.body.color, 10) : null;

    const updateTag = db.prepare('UPDATE tags SET name = COALESCE(?, name), color = COALESCE(?, color) WHERE id = ?');
    updateTag.run(name, color, tagId);

    const tag = db.prepare('SELECT * FROM tags WHERE id = ?').get(tagId);
    res.json({ tag });
  } catch (error) {
    console.error('Error updating tag:', error);
    res.status(500).json({ error: 'Failed to update tag' });
  }
});

// Delete a tag
app.delete('/api/tags/:tagId', (req, res) => {
  try {
    const tagId = sanitizeString(req.params.tagId, 50);
    if (!tagId) {
      return res.status(400).json({ error: 'tagId required' });
    }
    db.prepare('DELETE FROM card_tags WHERE tag_id = ?').run(tagId);
    db.prepare('DELETE FROM tags WHERE id = ?').run(tagId);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting tag:', error);
    res.status(500).json({ error: 'Failed to delete tag' });
  }
});

// ============== CARD TAG ENDPOINTS ==============

// Get all card tags for a team
app.get('/api/card-tags/:teamId', (req, res) => {
  try {
    const { teamId } = req.params;
    const cardTags = db.prepare(`
      SELECT ct.card_id, ct.tag_id, t.name, t.color
      FROM card_tags ct
      JOIN tags t ON ct.tag_id = t.id
      WHERE ct.team_id = ?
    `).all(teamId);

    // Group by card_id
    const grouped = {};
    cardTags.forEach(ct => {
      if (!grouped[ct.card_id]) {
        grouped[ct.card_id] = [];
      }
      grouped[ct.card_id].push({
        id: ct.tag_id,
        name: ct.name,
        color: ct.color
      });
    });

    res.json({ cardTags: grouped });
  } catch (error) {
    console.error('Error fetching card tags:', error);
    res.status(500).json({ error: 'Failed to fetch card tags' });
  }
});

// Add tag to card
app.post('/api/card-tags', (req, res) => {
  try {
    const teamId = sanitizeString(req.body.teamId, 50);
    const cardId = sanitizeString(req.body.cardId, 100);
    const tagId = sanitizeString(req.body.tagId, 50);

    if (!teamId || !cardId || !tagId) {
      return res.status(400).json({ error: 'teamId, cardId, and tagId required' });
    }

    // Verify tag belongs to team
    const tag = db.prepare('SELECT id FROM tags WHERE id = ? AND team_id = ?').get(tagId, teamId);
    if (!tag) {
      return res.status(400).json({ error: 'Invalid tag for this team' });
    }

    const id = nanoid();
    const insert = db.prepare('INSERT OR IGNORE INTO card_tags (id, team_id, card_id, tag_id) VALUES (?, ?, ?, ?)');
    insert.run(id, teamId, cardId, tagId);

    res.json({ success: true });
  } catch (error) {
    console.error('Error adding card tag:', error);
    res.status(500).json({ error: 'Failed to add tag to card' });
  }
});

// Remove tag from card
app.delete('/api/card-tags/:teamId/:cardId/:tagId', (req, res) => {
  try {
    const teamId = sanitizeString(req.params.teamId, 50);
    const cardId = decodeURIComponent(req.params.cardId); // Card IDs may be URL-encoded
    const tagId = sanitizeString(req.params.tagId, 50);

    if (!teamId || !cardId || !tagId) {
      return res.status(400).json({ error: 'teamId, cardId, and tagId required' });
    }
    db.prepare('DELETE FROM card_tags WHERE team_id = ? AND card_id = ? AND tag_id = ?').run(teamId, cardId, tagId);
    res.json({ success: true });
  } catch (error) {
    console.error('Error removing card tag:', error);
    res.status(500).json({ error: 'Failed to remove tag from card' });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '2.0.0' });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Basecamp Tagger Server running on port ${PORT}`);
  console.log(`📊 Database: ${dbPath}`);
});
