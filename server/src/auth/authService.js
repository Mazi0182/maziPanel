const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const config = require('../../config');

class AuthService {
  constructor() {
    this.users = [];
    this._initialized = false;
    this._dummyHash = bcrypt.hashSync('maziPanelDummyBcryptSeed123', 10);
  }

  _getUsersFilePath() {
    return path.join(config.DATA_DIR, 'users.json');
  }

  _getAdminFilePath() {
    return path.join(config.DATA_DIR, 'admin.json');
  }

  _loadUsers() {
    const usersFile = this._getUsersFilePath();
    const adminFile = this._getAdminFilePath();

    let loadedUsers = [];
    let needSave = false;

    if (fs.existsSync(usersFile)) {
      try {
        const raw = fs.readFileSync(usersFile, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          loadedUsers = parsed;
        }
      } catch (err) {
        console.error('Error reading users.json:', err.message);
      }
    }

    // Check backward compatibility with legacy admin.json
    if (fs.existsSync(adminFile)) {
      try {
        const rawAdmin = fs.readFileSync(adminFile, 'utf8');
        const adminData = JSON.parse(rawAdmin);
        if (adminData && adminData.username && adminData.passwordHash) {
          const normUsername = String(adminData.username).trim().toLowerCase();
          const existingIndex = loadedUsers.findIndex(
            (u) => String(u.username).trim().toLowerCase() === normUsername
          );

          if (existingIndex === -1) {
            // Migrate legacy admin into users list
            loadedUsers.unshift({
              username: normUsername,
              passwordHash: adminData.passwordHash,
              role: 'admin',
              passwordHint: adminData.passwordHint || null,
              createdAt: adminData.createdAt || new Date().toISOString(),
              updatedAt: adminData.updatedAt || adminData.createdAt || new Date().toISOString()
            });
            needSave = true;
          } else {
            // Ensure legacy admin has role 'admin'
            if (loadedUsers[existingIndex].role !== 'admin') {
              loadedUsers[existingIndex].role = 'admin';
              needSave = true;
            }
          }
        }
      } catch (err) {
        console.error('Error migrating legacy admin.json:', err.message);
      }
    }

    // Normalize all user entries
    this.users = loadedUsers.map((u) => ({
      username: String(u.username || '').trim().toLowerCase(),
      passwordHash: u.passwordHash,
      role: u.role === 'admin' ? 'admin' : 'user',
      tokenVersion: typeof u.tokenVersion === 'number' ? u.tokenVersion : 0,
      passwordHint: (u.passwordHint && String(u.passwordHint).trim()) ? String(u.passwordHint).trim() : null,
      createdAt: u.createdAt || new Date().toISOString(),
      updatedAt: u.updatedAt || u.createdAt || new Date().toISOString()
    })).filter((u) => u.username && u.passwordHash);

    if (needSave && this.users.length > 0) {
      this._saveUsers();
    }
  }

  _saveUsers() {
    const usersFile = this._getUsersFilePath();
    const adminFile = this._getAdminFilePath();

    try {
      const dataDir = path.dirname(usersFile);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }

      // Write users.json atomically
      const tmpUsersFile = `${usersFile}.tmp.${Date.now()}`;
      fs.writeFileSync(tmpUsersFile, JSON.stringify(this.users, null, 2), { mode: 0o600, encoding: 'utf8' });
      fs.renameSync(tmpUsersFile, usersFile);

      // Keep admin.json synchronized with first administrator for legacy compatibility
      const primaryAdmin = this.users.find((u) => u.role === 'admin');
      if (primaryAdmin) {
        const adminPayload = {
          username: primaryAdmin.username,
          passwordHash: primaryAdmin.passwordHash,
          role: 'admin',
          passwordHint: primaryAdmin.passwordHint || null,
          createdAt: primaryAdmin.createdAt,
          updatedAt: primaryAdmin.updatedAt
        };
        const tmpAdminFile = `${adminFile}.tmp.${Date.now()}`;
        fs.writeFileSync(tmpAdminFile, JSON.stringify(adminPayload, null, 2), { mode: 0o600, encoding: 'utf8' });
        fs.renameSync(tmpAdminFile, adminFile);
      }
    } catch (err) {
      console.error('Error saving users or admin file:', err.message);
    }
  }

  isInitialized() {
    this._loadUsers();
    return this.users.length > 0;
  }

  getFirstAdminUsername() {
    this._loadUsers();
    const admin = this.users.find((u) => u.role === 'admin');
    return admin ? admin.username : 'mazidev';
  }

  getAdminData() {
    this._loadUsers();
    const admin = this.users.find((u) => u.role === 'admin');
    if (!admin) return null;
    return {
      username: admin.username,
      passwordHash: admin.passwordHash,
      createdAt: admin.createdAt
    };
  }

  getStatus() {
    const initialized = this.isInitialized();
    // In accordance with security requirements: NEVER leak username in status
    return {
      initialized
    };
  }

  sanitizeUser(user) {
    if (!user) return null;
    return {
      username: user.username,
      role: user.role,
      tokenVersion: typeof user.tokenVersion === 'number' ? user.tokenVersion : 0,
      passwordHint: user.passwordHint || null,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt
    };
  }

  getInternalUser(username) {
    this._loadUsers();
    if (!username) return null;
    const norm = String(username).trim().toLowerCase();
    return this.users.find((u) => u.username === norm) || null;
  }

  async setupAdmin(username, password, passwordHint = null) {
    if (this.isInitialized()) {
      throw new Error('İlk yönetici kurulumu zaten tamamlanmış. Lütfen giriş yapın.');
    }

    if (!username || typeof username !== 'string') {
      throw new Error('Kullanıcı adı gereklidir.');
    }

    const normUsername = username.trim().toLowerCase();
    if (normUsername.length < 3 || normUsername.length > 32) {
      throw new Error('Kullanıcı adı 3 ile 32 karakter arasında olmalıdır.');
    }

    if (!/^[a-z0-9_-]+$/.test(normUsername)) {
      throw new Error('Kullanıcı adı yalnızca küçük harf, rakam, alt çizgi ve tire içerebilir.');
    }

    if (!password || typeof password !== 'string' || password.length < 6 || password.length > 72) {
      throw new Error('Şifre 6 ile 72 karakter arasında olmalıdır.');
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);
    const now = new Date().toISOString();

    const adminRecord = {
      username: normUsername,
      passwordHash,
      role: 'admin',
      tokenVersion: 0,
      passwordHint: (passwordHint && String(passwordHint).trim()) ? String(passwordHint).trim() : null,
      createdAt: now,
      updatedAt: now
    };

    this.users = [adminRecord];
    this._saveUsers();

    const token = this.generateToken({ username: adminRecord.username, role: 'admin', tokenVersion: 0 });

    return {
      success: true,
      message: 'İlk yönetici hesabı başarıyla oluşturuldu.',
      token,
      user: this.sanitizeUser(adminRecord)
    };
  }

  async login(username, password) {
    if (!this.isInitialized()) {
      throw new Error('Panel henüz yapılandırılmamış. Lütfen önce ilk yönetici kurulumunu tamamlayın.');
    }

    const cleanUser = (username && typeof username === 'string') ? username.trim().toLowerCase() : '';
    const cleanPass = (password && typeof password === 'string') ? password : '';

    if (!cleanUser || !cleanPass) {
      await bcrypt.compare(cleanPass || 'dummy', this._dummyHash);
      throw new Error('Geçersiz kullanıcı adı veya şifre.');
    }

    this._loadUsers();
    const user = this.users.find((u) => u.username === cleanUser);

    if (!user) {
      await bcrypt.compare(cleanPass, this._dummyHash);
      throw new Error('Geçersiz kullanıcı adı veya şifre.');
    }

    const isMatch = await bcrypt.compare(cleanPass, user.passwordHash);
    if (!isMatch) {
      throw new Error('Geçersiz kullanıcı adı veya şifre.');
    }

    const token = this.generateToken({
      username: user.username,
      role: user.role,
      tokenVersion: typeof user.tokenVersion === 'number' ? user.tokenVersion : 0
    });

    return {
      success: true,
      token,
      user: this.sanitizeUser(user)
    };
  }

  getUser(username) {
    this._loadUsers();
    if (!username) return null;
    const norm = String(username).trim().toLowerCase();
    const user = this.users.find((u) => u.username === norm);
    return user ? this.sanitizeUser(user) : null;
  }

  listUsers() {
    this._loadUsers();
    return this.users.map((u) => {
      const sanitized = this.sanitizeUser(u);
      delete sanitized.passwordHint;
      return sanitized;
    });
  }

  async createUser({ username, password, role = 'user', passwordHint = null }) {
    this._loadUsers();

    if (!username || typeof username !== 'string') {
      throw new Error('Kullanıcı adı gereklidir.');
    }

    const normUsername = username.trim().toLowerCase();
    if (normUsername.length < 3 || normUsername.length > 32) {
      throw new Error('Kullanıcı adı 3 ile 32 karakter arasında olmalıdır.');
    }

    if (!/^[a-z0-9_-]+$/.test(normUsername)) {
      throw new Error('Kullanıcı adı yalnızca küçük harf, rakam, alt çizgi ve tire içerebilir.');
    }

    if (!password || typeof password !== 'string' || password.length < 6 || password.length > 72) {
      throw new Error('Şifre 6 ile 72 karakter arasında olmalıdır.');
    }

    if (this.users.some((u) => u.username === normUsername)) {
      const err = new Error('Bu kullanıcı adı zaten kullanımda.');
      err.status = 409;
      throw err;
    }

    const targetRole = role === 'admin' ? 'admin' : 'user';
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);
    const now = new Date().toISOString();

    const record = {
      username: normUsername,
      passwordHash,
      role: targetRole,
      tokenVersion: 0,
      passwordHint: (passwordHint && String(passwordHint).trim()) ? String(passwordHint).trim() : null,
      createdAt: now,
      updatedAt: now
    };

    this.users.push(record);
    this._saveUsers();

    return this.sanitizeUser(record);
  }

  async updateUser(targetUsername, updates = {}, requestingUser) {
    this._loadUsers();

    if (!targetUsername) {
      throw new Error('Kullanıcı adı gereklidir.');
    }

    const normTarget = String(targetUsername).trim().toLowerCase();
    const index = this.users.findIndex((u) => u.username === normTarget);

    if (index === -1) {
      const err = new Error('Kullanıcı bulunamadı.');
      err.status = 404;
      throw err;
    }

    const isSelf = requestingUser && requestingUser.username && requestingUser.username.toLowerCase() === normTarget;
    const isAdmin = requestingUser && requestingUser.role === 'admin';

    if (!isAdmin && !isSelf) {
      const err = new Error('Yalnızca kendi hesabınızı değiştirebilirsiniz.');
      err.status = 403;
      throw err;
    }

    const targetUser = this.users[index];
    const oldUsername = targetUser.username;
    let newUsername = oldUsername;
    let token = null;

    // Handle username rename
    if (updates.username && String(updates.username).trim().toLowerCase() !== oldUsername) {
      const prospective = String(updates.username).trim().toLowerCase();
      if (prospective.length < 3 || prospective.length > 32) {
        throw new Error('Kullanıcı adı 3 ile 32 karakter arasında olmalıdır.');
      }
      if (!/^[a-z0-9_-]+$/.test(prospective)) {
        throw new Error('Kullanıcı adı yalnızca küçük harf, rakam, alt çizgi ve tire içerebilir.');
      }
      if (this.users.some((u) => u.username === prospective)) {
        const err = new Error('Bu kullanıcı adı zaten kullanımda.');
        err.status = 409;
        throw err;
      }
      newUsername = prospective;
      targetUser.username = newUsername;

      // Update server ownership references across serverRegistry
      try {
        const serverRegistry = require('../servers/serverRegistry');
        if (serverRegistry && typeof serverRegistry.updateServerOwner === 'function') {
          serverRegistry.updateServerOwner(oldUsername, newUsername);
        }
      } catch (e) {
        console.warn('[authService] Failed to notify serverRegistry of owner rename:', e.message);
      }
    }

    // Handle password change
    if (updates.password) {
      if (typeof updates.password !== 'string' || updates.password.length < 6 || updates.password.length > 72) {
        throw new Error('Şifre 6 ile 72 karakter arasında olmalıdır.');
      }
      const salt = await bcrypt.genSalt(10);
      targetUser.passwordHash = await bcrypt.hash(updates.password, salt);
      // Invalidate all previously issued tokens on password change
      targetUser.tokenVersion = (targetUser.tokenVersion || 0) + 1;
    }

    // Handle passwordHint update
    if (updates.passwordHint !== undefined) {
      targetUser.passwordHint = (updates.passwordHint && String(updates.passwordHint).trim())
        ? String(updates.passwordHint).trim()
        : null;
    }

    // Handle role update
    if (updates.role !== undefined && updates.role !== targetUser.role) {
      if (!isAdmin) {
        const err = new Error('Kullanıcı rollerini yalnızca yöneticiler değiştirebilir.');
        err.status = 403;
        throw err;
      }

      if (targetUser.role === 'admin' && updates.role !== 'admin') {
        const adminCount = this.users.filter((u) => u.role === 'admin').length;
        if (adminCount <= 1) {
          throw new Error('Son kalan yönetici hesabının yetkisi kaldırılamaz.');
        }
      }
      targetUser.role = updates.role === 'admin' ? 'admin' : 'user';
    }

    targetUser.updatedAt = new Date().toISOString();
    this.users[index] = targetUser;
    this._saveUsers();

    // If caller modified their own username, role, or credentials, issue fresh JWT token
    if (isSelf) {
      token = this.generateToken({
        username: targetUser.username,
        role: targetUser.role,
        tokenVersion: targetUser.tokenVersion || 0
      });
    }

    return {
      success: true,
      message: 'Kullanıcı bilgileri başarıyla güncellendi.',
      user: this.sanitizeUser(targetUser),
      token
    };
  }

  deleteUser(targetUsername, requestingUser) {
    this._loadUsers();

    if (!targetUsername) {
      throw new Error('Kullanıcı adı gereklidir.');
    }

    const normTarget = String(targetUsername).trim().toLowerCase();
    const index = this.users.findIndex((u) => u.username === normTarget);

    if (index === -1) {
      const err = new Error('Kullanıcı bulunamadı.');
      err.status = 404;
      throw err;
    }

    if (requestingUser && requestingUser.username && requestingUser.username.toLowerCase() === normTarget) {
      const err = new Error('Kendi aktif hesabınızı silemezsiniz.');
      err.status = 400;
      throw err;
    }

    const targetUser = this.users[index];
    if (targetUser.role === 'admin') {
      const adminCount = this.users.filter((u) => u.role === 'admin').length;
      if (adminCount <= 1) {
        const err = new Error('Son kalan yönetici hesabı silinemez.');
        err.status = 400;
        throw err;
      }
    }

    // Invalidate any active session before deletion
    targetUser.tokenVersion = (targetUser.tokenVersion || 0) + 1;
    this.users.splice(index, 1);
    this._saveUsers();

    // Clean up integrations & discord bot
    try {
      const discordBotService = require('../integrations/discordBotService');
      if (discordBotService && typeof discordBotService.stop === 'function') {
        discordBotService.stop(normTarget);
      }
    } catch (e) {
      console.warn('[authService] Discord bot durdurulamadı:', e.message);
    }

    try {
      const { integrationStorage } = require('../integrations/integrationStorage');
      if (integrationStorage && typeof integrationStorage.deleteUserData === 'function') {
        integrationStorage.deleteUserData(normTarget);
      }
    } catch (e) {
      console.warn('[authService] Kullanıcı entegrasyon dosyası silinemedi:', e.message);
    }

    return {
      success: true,
      message: 'Kullanıcı başarıyla silindi.'
    };
  }

  revokeAllSessions(username) {
    this._loadUsers();

    if (!username) {
      throw new Error('Kullanıcı adı gereklidir.');
    }

    const normTarget = String(username).trim().toLowerCase();
    const index = this.users.findIndex((u) => u.username === normTarget);

    if (index === -1) {
      const err = new Error('Kullanıcı bulunamadı.');
      err.status = 404;
      throw err;
    }

    this.users[index].tokenVersion = (this.users[index].tokenVersion || 0) + 1;
    this.users[index].updatedAt = new Date().toISOString();
    this._saveUsers();

    return {
      success: true,
      message: 'Tüm oturumlar başarıyla sonlandırıldı.'
    };
  }

  generateToken(payload) {
    const tokenPayload = {
      username: payload.username,
      role: payload.role,
      tokenVersion: typeof payload.tokenVersion === 'number' ? payload.tokenVersion : 0
    };
    return jwt.sign(tokenPayload, config.JWT_SECRET, { expiresIn: config.JWT_EXPIRES_IN, algorithm: 'HS256' });
  }

  verifyToken(token) {
    try {
      return jwt.verify(token, config.JWT_SECRET, { algorithms: ['HS256'] });
    } catch (err) {
      return null;
    }
  }
}

module.exports = new AuthService();
