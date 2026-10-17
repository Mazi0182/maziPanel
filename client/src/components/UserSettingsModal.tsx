import React, { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  User,
  UserPlus,
  KeyRound,
  Trash2,
  X,
  HelpCircle,
  LogOut,
  Check,
  AlertCircle,
  RefreshCw,
  Eye,
  EyeOff
} from 'lucide-react';
import { Tooltip } from './Tooltip';
import { ConfirmModal } from './ConfirmModal';

export interface UserAccount {
  username: string;
  role: 'admin' | 'user';
  passwordHint?: string | null;
  createdAt?: string;
}

interface UserSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentUser: { username: string; role?: string; passwordHint?: string | null } | null;
  onShowToast: (title: string, description?: string, type?: 'default' | 'success' | 'warning' | 'error' | 'info') => void;
  onUserUpdated?: (newUsername: string) => void;
  onLogout?: () => void;
}

export const UserSettingsModal: React.FC<UserSettingsModalProps> = ({
  isOpen,
  onClose,
  currentUser,
  onShowToast,
  onUserUpdated,
  onLogout,
}) => {
  const [activeSubTab, setActiveSubTab] = useState<'profile' | 'users'>('profile');

  // Profile Edit State
  const [newUsername, setNewUsername] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordHint, setPasswordHint] = useState('');
  const [showPasswords, setShowPasswords] = useState(false);
  const [isSavingProfile, setIsSavingProfile] = useState(false);

  // Users List State
  const [usersList, setUsersList] = useState<UserAccount[]>([]);
  const [isLoadingUsers, setIsLoadingUsers] = useState(false);

  // Add User State
  const [addUsername, setAddUsername] = useState('');
  const [addPassword, setAddPassword] = useState('');
  const [addHint, setAddHint] = useState('');
  const [addRole, setAddRole] = useState<'admin' | 'user'>('user');
  const [isAddingUser, setIsAddingUser] = useState(false);

  // Delete User Confirmation Modal
  const [deleteConfirmUser, setDeleteConfirmUser] = useState<string | null>(null);
  const [shouldRender, setShouldRender] = useState(isOpen);

  const isAdmin = currentUser?.role === 'admin';

  useEffect(() => {
    if (isOpen) {
      setShouldRender(true);
    } else {
      const timer = setTimeout(() => setShouldRender(false), 230);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  // Initialize form when opening
  useEffect(() => {
    if (isOpen && currentUser) {
      setNewUsername(currentUser.username || '');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPasswordHint(currentUser.passwordHint || '');
      if (currentUser.role !== 'admin') {
        setActiveSubTab('profile');
      } else {
        fetchUsers();
      }
    }
  }, [isOpen, currentUser]);

  const fetchUsers = useCallback(async () => {
    if (currentUser?.role !== 'admin') return;
    setIsLoadingUsers(true);
    try {
      const res = await fetch('/api/auth/users');
      if (res.ok) {
        const data = await res.json();
        const list: UserAccount[] = Array.isArray(data)
          ? data
          : (Array.isArray(data?.users) ? data.users : []);
        setUsersList(list);
      }
    } catch (err: any) {
      console.warn('Kullanıcı listesi alınamadı:', err.message);
    } finally {
      setIsLoadingUsers(false);
    }
  }, [currentUser?.role]);

  const handleUpdateProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentUser) return;

    if (newPassword && newPassword !== confirmPassword) {
      onShowToast('Şifre Uyuşmuyor', 'Yeni şifre ile şifre tekrarı birbiriyle eşleşmiyor.', 'error');
      return;
    }

    if (newPassword && newPassword.length < 6) {
      onShowToast('Yetersiz Şifre', 'Şifre en az 6 karakter olmalıdır.', 'warning');
      return;
    }

    setIsSavingProfile(true);
    try {
      const payload: any = {
        newUsername: newUsername.trim(),
        currentPassword: currentPassword || undefined,
        newPassword: newPassword || undefined,
        passwordHint: passwordHint.trim() || null,
      };

      const res = await fetch(`/api/auth/users/${encodeURIComponent(currentUser.username)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Profil güncellenemedi.');
      }

      onShowToast('Hesap Güncellendi', 'Kullanıcı bilgileri başarıyla kaydedildi.', 'success');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');

      if (onUserUpdated && data.user?.username) {
        onUserUpdated(data.user.username);
      }
      if (isAdmin) {
        fetchUsers();
      }
    } catch (err: any) {
      onShowToast('Güncelleme Hatası', err.message, 'error');
    } finally {
      setIsSavingProfile(false);
    }
  };

  const handleAddUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!addUsername.trim() || !addPassword) {
      onShowToast('Eksik Bilgi', 'Kullanıcı adı ve şifre zorunludur.', 'warning');
      return;
    }

    if (addPassword.length < 6) {
      onShowToast('Yetersiz Şifre', 'Şifre en az 6 karakter olmalıdır.', 'warning');
      return;
    }

    setIsAddingUser(true);
    try {
      const res = await fetch('/api/auth/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: addUsername.trim(),
          password: addPassword,
          role: addRole,
          passwordHint: addHint.trim() || null,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Kullanıcı oluşturulamadı.');
      }

      onShowToast('Kullanıcı Eklendi', `"${addUsername}" hesabı başarıyla oluşturuldu.`, 'success');
      setAddUsername('');
      setAddPassword('');
      setAddHint('');
      setAddRole('user');
      fetchUsers();
    } catch (err: any) {
      onShowToast('Ekleme Hatası', err.message, 'error');
    } finally {
      setIsAddingUser(false);
    }
  };

  const handleDeleteUser = async (targetUsername: string) => {
    try {
      const res = await fetch(`/api/auth/users/${encodeURIComponent(targetUsername)}`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Kullanıcı silinemedi.');
      }

      onShowToast('Kullanıcı Silindi', `"${targetUsername}" hesabı kaldırıldı.`, 'warning');
      fetchUsers();
    } catch (err: any) {
      onShowToast('Silme Hatası', err.message, 'error');
    } finally {
      setDeleteConfirmUser(null);
    }
  };

  if (!shouldRender) return null;

  return (
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget && isOpen) onClose();
      }}
      className={`fixed inset-0 z-[250] flex items-center justify-center p-4 overflow-y-auto ${
        isOpen ? 'pointer-events-auto' : 'pointer-events-none'
      }`}
    >
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: isOpen ? 1 : 0 }}
        transition={{ duration: 0.2, ease: 'easeOut' }}
        onClick={() => {
          if (isOpen) onClose();
        }}
        className="fixed inset-0 bg-black/85 backdrop-blur-xl"
      />

      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 10 }}
        animate={{
          opacity: isOpen ? 1 : 0,
          scale: isOpen ? 1 : 0.96,
          y: isOpen ? 0 : 10,
        }}
        transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-2xl rounded-3xl bg-zinc-950 border border-white/10 shadow-[0_25px_80px_rgba(0,0,0,0.95)] p-6 z-10 flex flex-col max-h-[90vh] my-auto overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-white/10 shrink-0">
          <div className="flex items-center gap-3">
            <div className="p-3 rounded-2xl bg-white/10 border border-white/15 text-white">
              <User className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-white tracking-wide">Kullanıcı Ayarları</h3>
              <p className="text-xs text-silver-400 font-sans mt-0.5">
                Aktif hesap: <span className="font-semibold text-white font-mono">{currentUser?.username}</span>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {onLogout && (
              <Tooltip content="Oturumu Kapat">
                <button
                  type="button"
                  onClick={onLogout}
                  className="p-2 rounded-2xl bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 hover:text-rose-200 border border-rose-500/20 transition-all text-xs flex items-center gap-1.5"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">Çıkış Yap</span>
                </button>
              </Tooltip>
            )}

            <button
              type="button"
              onClick={onClose}
              className="p-2 rounded-2xl bg-white/5 hover:bg-white/10 text-silver-400 hover:text-white border border-white/10 transition-colors"
              aria-label="Kapat"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Sub-tabs Header */}
        <div className="flex items-center gap-2 pt-4 pb-2 shrink-0 border-b border-white/5">
          <button
            type="button"
            onClick={() => setActiveSubTab('profile')}
            className={`relative px-4 py-2 rounded-xl text-xs font-semibold transition-colors ${
              activeSubTab === 'profile'
                ? 'text-black'
                : 'bg-white/5 hover:bg-white/10 text-silver-300 hover:text-white'
            }`}
          >
            {activeSubTab === 'profile' && (
              <motion.div
                layoutId="activeUserSettingsSubTabPill"
                transition={{ type: 'spring', stiffness: 420, damping: 32 }}
                className="absolute inset-0 rounded-xl bg-white shadow-[0_0_15px_rgba(255,255,255,0.25)]"
              />
            )}
            <span className="relative z-10">Hesap Bilgilerim</span>
          </button>

          {isAdmin && (
            <button
              type="button"
              onClick={() => {
                setActiveSubTab('users');
                fetchUsers();
              }}
              className={`relative px-4 py-2 rounded-xl text-xs font-semibold transition-colors ${
                activeSubTab === 'users'
                  ? 'text-black'
                  : 'bg-white/5 hover:bg-white/10 text-silver-300 hover:text-white'
              }`}
            >
              {activeSubTab === 'users' && (
                <motion.div
                  layoutId="activeUserSettingsSubTabPill"
                  transition={{ type: 'spring', stiffness: 420, damping: 32 }}
                  className="absolute inset-0 rounded-xl bg-white shadow-[0_0_15px_rgba(255,255,255,0.25)]"
                />
              )}
              <span className="relative z-10 flex items-center gap-1.5">
                <span>Kullanıcı Yönetimi</span>
                <span className={`px-1.5 py-0.2 rounded-full text-[10px] font-mono ${
                  activeSubTab === 'users' ? 'bg-black/15 text-black' : 'bg-white/10 text-silver-300'
                }`}>
                  {usersList.length}
                </span>
              </span>
            </button>
          )}
        </div>

        {/* Tab Body */}
        <div className="flex-1 overflow-y-auto py-4 pr-1">
          {activeSubTab === 'profile' || !isAdmin ? (
            <motion.form
              key="profile-tab"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
              onSubmit={handleUpdateProfile}
              className="space-y-4"
            >
                    <div>
                      <label className="text-xs font-semibold text-silver-300 mb-1.5 block">
                        Hesap Adı
                      </label>
                      <div className="relative flex items-center">
                        <User className="w-4 h-4 text-silver-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none z-10" />
                        <input
                          type="text"
                          required
                          value={newUsername}
                          onChange={(e) => setNewUsername(e.target.value)}
                          className="w-full pl-10 pr-4 py-2.5 rounded-2xl glass-input bg-zinc-900 border border-white/15 text-xs text-white font-mono focus:outline-none focus:border-white/40"
                        />
                      </div>
                    </div>

                    <div className="p-4 rounded-2xl bg-white/[0.02] border border-white/10 space-y-3">
                      <div className="flex items-center justify-between">
                        <h4 className="text-xs font-bold text-white flex items-center gap-1.5">
                          <KeyRound className="w-3.5 h-3.5 text-silver-300" />
                          <span>Şifre Değiştir</span>
                        </h4>
                        <button
                          type="button"
                          onClick={() => setShowPasswords(!showPasswords)}
                          className="text-[11px] text-silver-400 hover:text-white flex items-center gap-1 transition-colors"
                        >
                          {showPasswords ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                          <span>{showPasswords ? 'Gizle' : 'Göster'}</span>
                        </button>
                      </div>

                      <div>
                        <label className="text-[11px] text-silver-400 mb-1 block">
                          Mevcut Şifre
                        </label>
                        <input
                          type={showPasswords ? 'text' : 'password'}
                          value={currentPassword}
                          onChange={(e) => setCurrentPassword(e.target.value)}
                          placeholder="Şifreyi değiştirmek için mevcut şifrenizi girin"
                          className="w-full px-3.5 py-2 rounded-xl bg-zinc-900/80 border border-white/10 text-xs text-white font-mono focus:outline-none focus:border-white/30"
                        />
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <label className="text-[11px] text-silver-400 mb-1 block">
                            Yeni Şifre
                          </label>
                          <input
                            type={showPasswords ? 'text' : 'password'}
                            value={newPassword}
                            onChange={(e) => setNewPassword(e.target.value)}
                            placeholder="En az 6 karakter"
                            className="w-full px-3.5 py-2 rounded-xl bg-zinc-900/80 border border-white/10 text-xs text-white font-mono focus:outline-none focus:border-white/30"
                          />
                        </div>
                        <div>
                          <label className="text-[11px] text-silver-400 mb-1 block">
                            Yeni Şifre Tekrarı
                          </label>
                          <input
                            type={showPasswords ? 'text' : 'password'}
                            value={confirmPassword}
                            onChange={(e) => setConfirmPassword(e.target.value)}
                            placeholder="Tekrar girin"
                            className="w-full px-3.5 py-2 rounded-xl bg-zinc-900/80 border border-white/10 text-xs text-white font-mono focus:outline-none focus:border-white/30"
                          />
                        </div>
                      </div>
                    </div>

                    <div>
                      <label className="text-xs font-semibold text-silver-300 mb-1.5 flex items-center gap-1.5">
                        <HelpCircle className="w-3.5 h-3.5 text-silver-400" />
                        <span>Şifre İpucu</span>
                      </label>
                      <input
                        type="text"
                        value={passwordHint}
                        onChange={(e) => setPasswordHint(e.target.value)}
                        placeholder="Örn: İlk evcil hayvanım veya mezuniyet yılım"
                        className="w-full px-4 py-2.5 rounded-2xl glass-input bg-zinc-900 border border-white/15 text-xs text-white font-sans focus:outline-none focus:border-white/40"
                      />
                      <p className="text-[11px] text-silver-500 font-sans mt-1">
                        Şifrenizi unutursanız hatırlamanıza yardımcı olacak kişisel ipucu metni.
                      </p>
                    </div>

                    <div className="pt-4 border-t border-white/5 flex flex-col sm:flex-row items-center justify-between gap-3">
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            await fetch('/api/auth/logout-all', { method: 'POST', credentials: 'same-origin' });
                            onShowToast('Oturumlar Kapatıldı', 'Tüm cihazlardaki açık oturumlar sonlandırıldı.', 'info');
                            if (onLogout) {
                              onLogout();
                            } else {
                              window.dispatchEvent(new CustomEvent('mazipanel:logout'));
                            }
                          } catch (e: any) {
                            onShowToast('Hata', 'Oturumlar sonlandırılamadı.', 'error');
                          }
                        }}
                        className="w-full sm:w-auto flex items-center justify-center gap-1.5 px-4 py-2 rounded-2xl bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 hover:text-rose-200 border border-rose-500/20 text-xs font-semibold transition-all active:scale-95"
                      >
                        <LogOut className="w-3.5 h-3.5" />
                        <span>Tüm Oturumlardan Çıkış Yap</span>
                      </button>

                      <button
                        type="submit"
                        disabled={isSavingProfile}
                        className="w-full sm:w-auto flex items-center justify-center gap-2 px-5 py-2.5 rounded-2xl bg-white hover:bg-silver-200 text-black font-semibold text-xs transition-all shadow-[0_0_20px_rgba(255,255,255,0.25)] active:scale-95 disabled:opacity-50"
                      >
                        {isSavingProfile ? (
                          <>
                            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                            <span>Kaydediliyor...</span>
                          </>
                        ) : (
                          <>
                            <Check className="w-3.5 h-3.5" />
                            <span>Değişiklikleri Kaydet</span>
                          </>
                        )}
                      </button>
                    </div>
                  </motion.form>
                ) : (
                  <motion.div
                    key="users-tab"
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
                    className="space-y-6"
                  >
                    {/* Existing Users List */}
                    <div className="space-y-2">
                      <h4 className="text-xs font-bold text-silver-300 uppercase tracking-wider">
                        Kayıtlı Kullanıcılar
                      </h4>

                      {isLoadingUsers ? (
                        <div className="p-6 text-center text-silver-500 text-xs flex items-center justify-center gap-2">
                          <RefreshCw className="w-4 h-4 animate-spin" />
                          <span>Kullanıcılar yükleniyor...</span>
                        </div>
                      ) : usersList.length === 0 ? (
                        <div className="p-4 rounded-2xl bg-white/[0.02] border border-white/10 text-silver-400 text-xs text-center">
                          Henüz kayıtlı kullanıcı bulunmuyor.
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {usersList.map((usr) => {
                            const isCurrent = usr.username === currentUser?.username;
                            return (
                              <div
                                key={usr.username}
                                className="flex items-center justify-between p-3.5 rounded-2xl bg-white/[0.02] border border-white/10 hover:border-white/20 transition-all"
                              >
                                <div className="flex items-center gap-3 min-w-0">
                                  <div className="p-2 rounded-xl bg-white/10 border border-white/15 text-white shrink-0">
                                    <User className="w-4 h-4" />
                                  </div>
                                  <div className="min-w-0">
                                    <div className="flex items-center gap-2">
                                      <span className="font-bold text-xs text-white font-mono truncate">
                                        {usr.username}
                                      </span>
                                      {isCurrent && (
                                        <span className="px-1.5 py-0.5 rounded bg-white/15 text-[10px] font-mono text-white">
                                          Siz
                                        </span>
                                      )}
                                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${
                                        usr.role === 'admin'
                                          ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                                          : 'bg-white/10 text-silver-300'
                                      }`}>
                                        {usr.role === 'admin' ? 'Yönetici' : 'Kullanıcı'}
                                      </span>
                                    </div>
                                    {usr.passwordHint && (
                                      <p className="text-[11px] text-silver-400 truncate mt-0.5">
                                        İpucu: {usr.passwordHint}
                                      </p>
                                    )}
                                  </div>
                                </div>

                                {!isCurrent && (
                                  <button
                                    type="button"
                                    onClick={() => setDeleteConfirmUser(usr.username)}
                                    className="p-2 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 hover:text-rose-200 border border-rose-500/20 transition-all text-xs"
                                    title="Kullanıcıyı Sil"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>

                    {/* Add New User Box */}
                    <div className="p-5 rounded-2xl bg-white/[0.02] border border-white/10 space-y-4">
                      <div className="flex items-center gap-2">
                        <div className="p-2 rounded-xl bg-white/10 text-white">
                          <UserPlus className="w-4 h-4" />
                        </div>
                        <div>
                          <h4 className="text-xs font-bold text-white">Yeni Kullanıcı Hesabı Ekle</h4>
                          <p className="text-[11px] text-silver-400">
                            Yeni hesap kendi sunucularını oluşturabilir ve izole şekilde yönetebilir.
                          </p>
                        </div>
                      </div>

                      <form onSubmit={handleAddUser} className="space-y-3 pt-2">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <div>
                            <label className="text-[11px] text-silver-400 mb-1 block">Kullanıcı Adı</label>
                            <input
                              type="text"
                              required
                              value={addUsername}
                              onChange={(e) => setAddUsername(e.target.value)}
                              placeholder="Örn: developer"
                              className="w-full px-3.5 py-2 rounded-xl bg-zinc-900 border border-white/10 text-xs text-white font-mono focus:outline-none focus:border-white/30"
                            />
                          </div>
                          <div>
                            <label className="text-[11px] text-silver-400 mb-1 block">Şifre</label>
                            <input
                              type="password"
                              required
                              value={addPassword}
                              onChange={(e) => setAddPassword(e.target.value)}
                              placeholder="En az 6 karakter"
                              className="w-full px-3.5 py-2 rounded-xl bg-zinc-900 border border-white/10 text-xs text-white font-mono focus:outline-none focus:border-white/30"
                            />
                          </div>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <div>
                            <label className="text-[11px] text-silver-400 mb-1 block">
                              Şifre İpucu
                            </label>
                            <input
                              type="text"
                              value={addHint}
                              onChange={(e) => setAddHint(e.target.value)}
                              placeholder="Hatırlatıcı not"
                              className="w-full px-3.5 py-2 rounded-xl bg-zinc-900 border border-white/10 text-xs text-white font-sans focus:outline-none focus:border-white/30"
                            />
                          </div>
                          <div>
                            <label className="text-[11px] text-silver-400 mb-1 block">Hesap Rolü</label>
                            <select
                              value={addRole}
                              onChange={(e) => setAddRole(e.target.value as any)}
                              className="w-full px-3 py-2 rounded-xl bg-zinc-900 border border-white/10 text-xs text-white font-mono focus:outline-none focus:border-white/30"
                            >
                              <option value="user">Standart Kullanıcı</option>
                              <option value="admin">Yönetici</option>
                            </select>
                          </div>
                        </div>

                        <div className="pt-2 flex justify-end">
                          <button
                            type="submit"
                            disabled={isAddingUser}
                            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-white hover:bg-silver-200 text-black font-semibold text-xs transition-all active:scale-95 disabled:opacity-50"
                          >
                            {isAddingUser ? (
                              <>
                                <RefreshCw className="w-3 h-3 animate-spin" />
                                <span>Oluşturuluyor...</span>
                              </>
                            ) : (
                              <>
                                <UserPlus className="w-3.5 h-3.5" />
                                <span>Kullanıcıyı Kaydet</span>
                              </>
                            )}
                          </button>
                        </div>
                      </form>
                    </div>
                  </motion.div>
                )}
            </div>
          </motion.div>

          {/* Delete Confirmation Modal */}
          <ConfirmModal
            isOpen={!!deleteConfirmUser}
            title="Kullanıcıyı Sil"
            message={`"${deleteConfirmUser}" hesabını silmek istediğinize emin misiniz? Bu işlem geri alınamaz.`}
            confirmText="Evet, Sil"
            cancelText="Vazgeç"
            variant="danger"
            onConfirm={() => {
              if (deleteConfirmUser) handleDeleteUser(deleteConfirmUser);
            }}
            onCancel={() => setDeleteConfirmUser(null)}
          />
        </div>
  );
};
