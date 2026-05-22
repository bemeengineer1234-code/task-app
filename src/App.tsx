/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { 
  Play, 
  Pause, 
  CheckCircle2, 
  Plus, 
  LayoutDashboard, 
  Calendar as CalendarIcon, 
  MessageSquare, 
  Settings, 
  LogOut, 
  Menu, 
  X, 
  Search, 
  Bell, 
  User, 
  Sparkles, 
  Clock, 
  AlertTriangle, 
  ChevronRight, 
  MoreVertical,
  Paperclip,
  ThumbsUp,
  Layers,
  Image as ImageIcon,
  Camera
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import confetti from 'canvas-confetti';
import { format, startOfMonth, endOfMonth, eachDayOfInterval, isSameDay, addMonths, subMonths, isToday, isTomorrow } from 'date-fns';
import { ja } from 'date-fns/locale';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { db } from './lib/firebase';
import { collection, query, onSnapshot, doc, getDoc, setDoc, updateDoc, deleteDoc, Timestamp } from 'firebase/firestore';

// --- Utils ---
function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// --- Types (Matching Firestore Schema from Specification) ---

interface UserProfile {
  id: string;
  displayName: string;
  avatarUrl?: string;
  slackUid: string;
  backgroundImageUrl: string;
  currentStreak: number;
  badges: string[];
  fightCount: number;
  lastLoginAt?: Date;
}

type TaskStatus = 'todo' | 'doing' | 'paused_break' | 'paused_urgent' | 'retained' | 'done';
type TaskPriority = 'high' | 'medium' | 'low';
interface Task {
  id: string;
  userId: string;
  assignedBy: string;
  parentId: string | null;
  title: string;
  description: string;
  priority: TaskPriority;
  category: string;
  estimatedMinutes: number;
  actualMinutes: number;
  status: TaskStatus;
  mismatchReason: string;
  attachments: { name: string; url: string }[];
  startPhoto?: string;
  dueDate: Date;
  updatedAt: Date;
  startedAt?: Date;
  fights?: { senderId: string, timestamp: number }[];
}

interface Notification {
  id: string;
  userId: string;
  userName: string;
  type: 'start' | 'end' | 'paused' | 'assigned' | 'fight';
  taskTitle: string;
  timestamp: Date;
}

interface ChatMessage {
  id: string;
  senderId: string;
  receiverId: string;
  text: string;
  timestamp: Date;
  relatedTaskId?: string;
}

interface ChatThread {
  id: string;
  relatedTaskId: string;
  participantIds: string[];
  messages: ChatMessage[];
}

// --- Mock Data ---

const DEFAULT_USER_PROFILE: UserProfile = {
  id: '',
  displayName: 'ゲスト',
  slackUid: '',
  backgroundImageUrl: '',
  currentStreak: 0,
  badges: [],
  fightCount: 0
};

const INITIAL_TASKS: Task[] = [];

const TASKS_COLLECTION = 'tasks';
const MEMBERS_COLLECTION = 'members';
const MESSAGES_COLLECTION = 'chatMessages';
const SESSION_STORAGE_KEY = 'syncTaskGamifySession';
const LAST_EMAIL_STORAGE_KEY = 'syncTaskGamifyLastEmail';
const LOCAL_MEMBERS_STORAGE_KEY = 'syncTaskGamifyUsers';
const LOCAL_MESSAGES_STORAGE_KEY = 'syncTaskGamifyMessages';

function createId() {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2, 11);
}

function toFirestoreValue(value: unknown): unknown {
  if (value instanceof Date) return Timestamp.fromDate(value);
  if (Array.isArray(value)) return value.map(toFirestoreValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, toFirestoreValue(v)])
    );
  }
  return value;
}

function toFirestoreDoc<T extends object>(data: T): Record<string, unknown> {
  const { id: _id, ...rest } = data as T & { id?: string };
  return toFirestoreValue(rest) as Record<string, unknown>;
}
const IS_FIRESTORE_CONFIGURED = Boolean(
  import.meta.env.VITE_FIREBASE_API_KEY &&
  import.meta.env.VITE_FIREBASE_AUTH_DOMAIN &&
  import.meta.env.VITE_FIREBASE_PROJECT_ID &&
  import.meta.env.VITE_FIREBASE_STORAGE_BUCKET &&
  import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID &&
  import.meta.env.VITE_FIREBASE_APP_ID
);

function normalizeFirestoreDate(value: any): Date {
  if (!value) return new Date();
  if (typeof value.toDate === 'function') return value.toDate();
  return new Date(value);
}

function deserializeTask(entry: any, id?: string): Task {
  return {
    id: id || entry.id || '',
    userId: entry.userId || '',
    assignedBy: entry.assignedBy || '',
    parentId: entry.parentId ?? null,
    title: entry.title || '',
    description: entry.description || '',
    priority: entry.priority || 'medium',
    category: entry.category || '作業',
    estimatedMinutes: entry.estimatedMinutes || 30,
    actualMinutes: entry.actualMinutes || 0,
    status: entry.status || 'todo',
    mismatchReason: entry.mismatchReason || '',
    attachments: entry.attachments || [],
    startPhoto: entry.startPhoto,
    dueDate: normalizeFirestoreDate(entry.dueDate),
    updatedAt: normalizeFirestoreDate(entry.updatedAt),
    startedAt: entry.startedAt ? normalizeFirestoreDate(entry.startedAt) : undefined,
    fights: entry.fights || []
  };
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function deserializeMember(entry: any, id?: string): UserProfile {
  const memberId = id || entry.id || entry.email || '';
  return {
    id: memberId,
    displayName: entry.displayName || entry.email?.split('@')[0] || memberId.split('@')[0] || 'ゲスト',
    avatarUrl: entry.avatarUrl || '',
    slackUid: entry.slackUid || entry.email?.split('@')[0] || memberId.split('@')[0] || '',
    backgroundImageUrl: entry.backgroundImageUrl || '',
    currentStreak: entry.currentStreak || 0,
    badges: entry.badges || [],
    fightCount: entry.fightCount || 0,
    lastLoginAt: entry.lastLoginAt ? normalizeFirestoreDate(entry.lastLoginAt) : undefined
  };
}

function loadMembersFromLocalStorage(): UserProfile[] {
  if (typeof window === 'undefined') return [];
  try {
    const stored = JSON.parse(localStorage.getItem(LOCAL_MEMBERS_STORAGE_KEY) || '{}');
    return Object.entries(stored).map(([id, data]) => deserializeMember(data, id));
  } catch {
    return [];
  }
}

function persistMemberToLocalStorage(member: UserProfile) {
  if (typeof window === 'undefined') return;
  try {
    const stored = JSON.parse(localStorage.getItem(LOCAL_MEMBERS_STORAGE_KEY) || '{}');
    stored[member.id] = {
      ...member,
      lastLoginAt: member.lastLoginAt?.toISOString?.() ?? member.lastLoginAt
    };
    localStorage.setItem(LOCAL_MEMBERS_STORAGE_KEY, JSON.stringify(stored));
  } catch (e) {
    console.error('Local member save failed:', e);
  }
}

async function saveTaskToFirestore(task: Task) {
  if (!db) {
    try {
      const stored = JSON.parse(localStorage.getItem('syncTaskGamifyTasks') || '[]');
      localStorage.setItem('syncTaskGamifyTasks', JSON.stringify([...stored, task]));
    } catch(e) {}
    return;
  }
  try {
    await setDoc(doc(db, TASKS_COLLECTION, task.id), toFirestoreDoc(task));
  } catch (error) {
    console.error('Firestore save task failed:', error);
    throw error;
  }
}

async function updateTaskInFirestore(taskId: string, data: Partial<Task>) {
  if (!db) {
    try {
      const stored = JSON.parse(localStorage.getItem('syncTaskGamifyTasks') || '[]');
      const updated = stored.map((t: any) => t.id === taskId ? { ...t, ...data } : t);
      localStorage.setItem('syncTaskGamifyTasks', JSON.stringify(updated));
    } catch(e) {}
    return;
  }
  try {
    await updateDoc(doc(db, TASKS_COLLECTION, taskId), toFirestoreDoc(data));
  } catch (error) {
    console.error('Firestore update task failed:', error);
    throw error;
  }
}

async function deleteTaskFromFirestore(taskId: string) {
  if (!db) {
    try {
      const stored = JSON.parse(localStorage.getItem('syncTaskGamifyTasks') || '[]');
      localStorage.setItem('syncTaskGamifyTasks', JSON.stringify(stored.filter((t: any) => t.id !== taskId)));
    } catch(e) {}
    return;
  }
  try {
    await deleteDoc(doc(db, TASKS_COLLECTION, taskId));
  } catch (error) {
    console.error('Firestore delete task failed:', error);
  }
}

async function saveMemberToFirestore(member: Partial<UserProfile> & { id: string }) {
  if (!db) return;
  try {
    const payload: Record<string, unknown> = { ...member };
    if (member.lastLoginAt instanceof Date) {
      payload.lastLoginAt = member.lastLoginAt;
    }
    await setDoc(doc(db, MEMBERS_COLLECTION, member.id), payload, { merge: true });
  } catch (error) {
    console.error('Firestore save member failed:', error);
    throw error;
  }
}

function persistMessageLocally(msg: ChatMessage) {
  if (typeof window === 'undefined') return;
  try {
    const stored: ChatMessage[] = JSON.parse(localStorage.getItem(LOCAL_MESSAGES_STORAGE_KEY) || '[]');
    const normalized = {
      ...msg,
      senderId: normalizeEmail(msg.senderId),
      receiverId: normalizeEmail(msg.receiverId),
      timestamp: msg.timestamp instanceof Date ? msg.timestamp.toISOString() : msg.timestamp
    };
    localStorage.setItem(
      LOCAL_MESSAGES_STORAGE_KEY,
      JSON.stringify([...stored.filter(m => m.id !== msg.id), normalized])
    );
  } catch (e) {
    console.error('Local message save failed:', e);
  }
}

function loadMessagesFromLocalStorage(): ChatMessage[] {
  if (typeof window === 'undefined') return [];
  try {
    const stored = JSON.parse(localStorage.getItem(LOCAL_MESSAGES_STORAGE_KEY) || '[]');
    return stored.map((m: any) => ({
      ...m,
      senderId: normalizeEmail(m.senderId),
      receiverId: normalizeEmail(m.receiverId),
      timestamp: normalizeFirestoreDate(m.timestamp)
    })) as ChatMessage[];
  } catch {
    return [];
  }
}

async function saveMessageToFirestore(msg: ChatMessage) {
  const normalized: ChatMessage = {
    ...msg,
    senderId: normalizeEmail(msg.senderId),
    receiverId: normalizeEmail(msg.receiverId)
  };
  persistMessageLocally(normalized);

  if (!db) return;
  try {
    await setDoc(doc(db, MESSAGES_COLLECTION, normalized.id), toFirestoreDoc(normalized));
  } catch (error) {
    console.error('Firestore save message failed:', error);
    throw error;
  }
}

function buildAssignedTaskCopy(source: Task, targetUserId: string, assignedBy: string): Task {
  return {
    ...source,
    id: createId(),
    userId: normalizeEmail(targetUserId),
    assignedBy: normalizeEmail(assignedBy),
    parentId: null,
    status: 'todo',
    actualMinutes: 0,
    startPhoto: undefined,
    mismatchReason: '',
    startedAt: undefined,
    updatedAt: new Date()
  };
}

async function deleteMessageFromFirestore(msgId: string) {
  if (!db) return;
  try {
    await deleteDoc(doc(db, MESSAGES_COLLECTION, msgId));
  } catch (error) {
    console.error('Firestore delete message failed:', error);
  }
}

function createUserProfile(email: string, avatarUrl?: string, slackUid?: string): UserProfile {
  const displayName = email.split('@')[0];
  return {
    id: email,
    displayName,
    slackUid: slackUid || displayName,
    backgroundImageUrl: '',
    avatarUrl,
    currentStreak: 0,
    badges: [],
    fightCount: 0
  };
}

// --- Components ---

export default function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [sessionBootstrapped, setSessionBootstrapped] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia('(min-width: 1024px)').matches : false
  );
  const [activeTab, setActiveTab] = useState<'dashboard' | 'calendar' | 'messages' | 'members' | 'settings'>('dashboard');
  const [showCompleted, setShowCompleted] = useState(false);
  const [tasks, setTasks] = useState<Task[]>(() => {
    if (typeof window === 'undefined') return INITIAL_TASKS;
    if (!IS_FIRESTORE_CONFIGURED) {
      try {
        const storedTasks = JSON.parse(localStorage.getItem('syncTaskGamifyTasks') || '[]');
        return storedTasks.map((t: any) => deserializeTask(t));
      } catch (e) {
        return [];
      }
    }
    return [];
  });
  const [members, setMembers] = useState<UserProfile[]>(() => {
    if (typeof window === 'undefined') return [];
    if (!IS_FIRESTORE_CONFIGURED) return loadMembersFromLocalStorage();
    return [];
  });
  const [userProfile, setUserProfile] = useState<UserProfile>(DEFAULT_USER_PROFILE);
  // `isLocked` と `activeTaskId` は `useState` ではなく `currentUserTasks` から導出する（後述）
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>(() => {
    if (typeof window === 'undefined' || IS_FIRESTORE_CONFIGURED) return [];
    return loadMessagesFromLocalStorage();
  });
  const [progressTick, setProgressTick] = useState(0);
  const [timerSeconds, setTimerSeconds] = useState(2700); // 45 mins
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [showTaskForm, setShowTaskForm] = useState(false);
  const [showGapModal, setShowGapModal] = useState(false);
  const [showRescueModal, setShowRescueModal] = useState(false);
  const [showMemberDetail, setShowMemberDetail] = useState(false);
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);
  const [targetParentId, setTargetParentId] = useState<string | null>(null);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [pendingCompleteTask, setPendingCompleteTask] = useState<Task | null>(null);
  const [showPhotoModal, setShowPhotoModal] = useState(false);
  const [pendingStartTaskId, setPendingStartTaskId] = useState<string | null>(null);
  const [reactionSent, setReactionSent] = useState<Record<string, boolean>>({});
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [showNotifications, setShowNotifications] = useState(false);
  const [toasts, setToasts] = useState<{id: string, message: string}[]>([]);
  const [unreadMessageCount, setUnreadMessageCount] = useState(0);
  const prevMessageIdsRef = useRef<Set<string>>(new Set());
  const isFirstMessageLoad = useRef(true);

  const showToast = (message: string) => {
    const id = Math.random().toString(36).substring(2);
    setToasts(prev => [...prev, {id, message}]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 4000);
  };
  const [selectedCategory, setSelectedCategory] = useState<string>('すべて');
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [availableCategories, setAvailableCategories] = useState<string[]>(['作業', '調査', '会議', '休憩', 'Design', 'Engineering', 'Marketing']);
  const [lastCreatedTaskId, setLastCreatedTaskId] = useState<string | null>(null);

  const currentUserTasks = useMemo(() => {
    return tasks.filter(t => t.userId === userProfile.id);
  }, [tasks, userProfile.id]);

  const activeTask = useMemo(() => {
    return currentUserTasks.find(t => t.status === 'doing') || null;
  }, [currentUserTasks]);

  const activeTaskId = activeTask?.id || null;
  const isLocked = !!activeTask;

  // Timer Logic
  useEffect(() => {
    let interval: NodeJS.Timeout;
    const task = tasks.find(t => t.id === activeTaskId);
    if (isLocked && timerSeconds > 0 && task?.status === 'doing') {
      interval = setInterval(() => {
        setTimerSeconds(prev => prev - 1);
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [isLocked, timerSeconds, activeTaskId, tasks]);

  useEffect(() => {
    const hasActive = tasks.some(t => t.status === 'doing');
    if (!hasActive) return;
    const id = setInterval(() => setProgressTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, [tasks]);

  const memberProgress = useMemo(() => {
    const list = members.map(member => {
      const memberId = normalizeEmail(member.id);
      const activeTask = tasks.find(t => normalizeEmail(t.userId) === memberId && t.status === 'doing');
      const pendingTasks = tasks.filter(t => normalizeEmail(t.userId) === memberId && t.status !== 'done' && !t.parentId);
      const elapsedMinutes = activeTask?.startedAt
        ? Math.max(0, Math.floor((Date.now() - activeTask.startedAt.getTime()) / 60000))
        : 0;
      const progressPercent = activeTask
        ? Math.min(100, Math.round((elapsedMinutes / Math.max(activeTask.estimatedMinutes || 1, 1)) * 100))
        : 0;
      return {
        userId: member.id,
        member,
        activeTask,
        taskTitle: activeTask ? activeTask.title : (pendingTasks[0]?.title || ''),
        status: activeTask ? 'doing' as const : pendingTasks.length ? 'waiting' as const : 'none' as const,
        progress: activeTask ? progressPercent : 0,
        elapsedMinutes,
        pendingCount: pendingTasks.length,
        startPhoto: activeTask?.startPhoto
      };
    });

    return list.sort((a, b) => {
      if (a.status === 'doing' && b.status !== 'doing') return -1;
      if (a.status !== 'doing' && b.status === 'doing') return 1;
      if (a.status === 'none' && b.status !== 'none') return 1;
      if (a.status !== 'none' && b.status === 'none') return -1;
      return a.member.displayName.localeCompare(b.member.displayName, 'ja');
    });
  }, [members, tasks, progressTick]);

  useEffect(() => {
    if (typeof window === 'undefined' || !IS_FIRESTORE_CONFIGURED || !db) return;
    const tasksQuery = query(collection(db, TASKS_COLLECTION));
    const unsubscribe = onSnapshot(tasksQuery, snapshot => {
      const loadedTasks = snapshot.docs.map(docSnapshot => deserializeTask({ ...docSnapshot.data(), id: docSnapshot.id }));
      setTasks(loadedTasks);
    }, (error) => {
      console.error('Firestore tasks snapshot failed:', error);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || !IS_FIRESTORE_CONFIGURED || !db) return;
    const membersQuery = query(collection(db, MEMBERS_COLLECTION));
    const unsubscribe = onSnapshot(membersQuery, snapshot => {
      const loadedMembers = snapshot.docs.map(docSnapshot => deserializeMember(docSnapshot.data(), docSnapshot.id));
      setMembers(loadedMembers);
    }, (error) => {
      console.error('Firestore members snapshot failed:', error);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || !IS_FIRESTORE_CONFIGURED || !db) return;
    const messagesQuery = query(collection(db, MESSAGES_COLLECTION));
    const unsubscribe = onSnapshot(messagesQuery, snapshot => {
      const loadedMessages = snapshot.docs.map(docSnapshot => {
        const data = docSnapshot.data();
        return {
          ...data,
          id: docSnapshot.id,
          senderId: normalizeEmail(data.senderId || ''),
          receiverId: normalizeEmail(data.receiverId || ''),
          timestamp: normalizeFirestoreDate(data.timestamp)
        } as ChatMessage;
      });
      setChatMessages(loadedMessages.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime()));
    }, (error) => {
      console.error('Firestore messages snapshot failed:', error);
      setChatMessages(loadMessagesFromLocalStorage());
    });
    return () => unsubscribe();
  }, []);

  // 新着メッセージ検知・通知
  useEffect(() => {
    const myId = normalizeEmail(userProfile.id);
    const currentIds = new Set(chatMessages.map(m => m.id));

    if (isFirstMessageLoad.current) {
      isFirstMessageLoad.current = false;
      prevMessageIdsRef.current = currentIds;
      return;
    }

    const newMsgs = chatMessages.filter(m =>
      !prevMessageIdsRef.current.has(m.id) &&
      normalizeEmail(m.receiverId) === myId &&
      normalizeEmail(m.senderId) !== myId
    );

    if (newMsgs.length > 0) {
      const sender = members.find(mem => normalizeEmail(mem.id) === normalizeEmail(newMsgs[0].senderId));
      const senderName = sender?.displayName || '誰か';
      const preview = newMsgs[0].text ? newMsgs[0].text.slice(0, 20) : 'タスクを共有しました';
      showToast(`💬 ${senderName}: ${preview}`);
      if (activeTab !== 'messages') {
        setUnreadMessageCount(prev => prev + newMsgs.length);
      }
      if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted') {
        new Notification('SyncTask メッセージ', {
          body: `${senderName}: ${preview}`,
          icon: '/favicon.ico'
        });
      }
    }

    prevMessageIdsRef.current = currentIds;
  }, [chatMessages]);

  // メッセージタブを開いたら未読をリセット
  useEffect(() => {
    if (activeTab === 'messages') {
      setUnreadMessageCount(0);
    }
  }, [activeTab]);

  // ブラウザ通知の許可リクエスト（初回ログイン後）
  useEffect(() => {
    if (isLoggedIn && typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }, [isLoggedIn]);

  // 新規アサインタスクの通知検知
  const [prevTaskIds, setPrevTaskIds] = useState<string[]>([]);
  useEffect(() => {
    if (tasks.length === 0) return;
    if (prevTaskIds.length === 0) {
      setPrevTaskIds(tasks.map(t => t.id));
      return;
    }
    const newTasks = tasks.filter(t => !prevTaskIds.includes(t.id));
    if (newTasks.length > 0) {
      newTasks.forEach(t => {
        if (t.userId === userProfile.id && t.assignedBy && t.assignedBy !== userProfile.id) {
          const sender = members.find(m => m.id === t.assignedBy);
          addNotification('assigned', `タスク「${t.title}」が ${sender?.displayName || '誰か'} さんから送られました`);
        }
      });
      setPrevTaskIds(tasks.map(t => t.id));
    }
  }, [tasks, userProfile.id, prevTaskIds, members]);

  // FIGHTの通知と検出
  const prevFights = useRef<Record<string, number>>({});
  useEffect(() => {
    const activeTasks = tasks.filter(t => t.userId === userProfile.id && t.status === 'doing');
    activeTasks.forEach(task => {
      const currentLen = task.fights?.length || 0;
      const prevLen = prevFights.current[task.id] || 0;
      if (currentLen > prevLen && currentLen > 0) {
        const newFight = task.fights![currentLen - 1];
        const sender = members.find(m => m.id === newFight.senderId);
        addNotification('fight', `${sender?.displayName || '誰か'} さんからFIGHTされました！`);
      }
      prevFights.current[task.id] = currentLen;
    });
  }, [tasks, userProfile.id, members]);

  // メンバー情報から自身のfightCount等を同期
  useEffect(() => {
    const me = members.find(m => m.id === userProfile.id);
    if (me && me.fightCount !== userProfile.fightCount) {
      setUserProfile(prev => ({ ...prev, fightCount: me.fightCount }));
    }
  }, [members, userProfile.id, userProfile.fightCount]);

  // プロフィール変更時の自動保存
  const isProfileMount = useRef(true);
  useEffect(() => {
    if (isProfileMount.current) {
      isProfileMount.current = false;
      return;
    }
    if (userProfile.id) {
       const timeout = setTimeout(() => {
         saveMemberToFirestore(userProfile).catch(() => {});
         persistMemberToLocalStorage(userProfile);
         if (!IS_FIRESTORE_CONFIGURED) {
           setMembers(loadMembersFromLocalStorage());
         }
       }, 500);
       return () => clearTimeout(timeout);
    }
  }, [userProfile.displayName, userProfile.avatarUrl, userProfile.backgroundImageUrl, userProfile.slackUid]);

  const loginWithEmail = async (rawEmail: string): Promise<boolean> => {
    const email = normalizeEmail(rawEmail);
    if (!email.includes('@')) return false;

    const now = new Date();
    let profile: UserProfile;

    if (IS_FIRESTORE_CONFIGURED && db) {
      try {
        const memberRef = doc(db, MEMBERS_COLLECTION, email);
        const memberSnapshot = await getDoc(memberRef);
        if (memberSnapshot.exists()) {
          profile = {
            ...deserializeMember(memberSnapshot.data(), memberSnapshot.id),
            lastLoginAt: now
          };
        } else {
          profile = { ...createUserProfile(email), lastLoginAt: now };
        }
        await saveMemberToFirestore(profile);
        persistMemberToLocalStorage(profile);
        setUserProfile(profile);
        setIsLoggedIn(true);
        localStorage.setItem(SESSION_STORAGE_KEY, email);
        localStorage.setItem(LAST_EMAIL_STORAGE_KEY, email);
        return true;
      } catch (error) {
        console.error('Firestore login error:', error);
      }
    }

    const storedUsers = JSON.parse(localStorage.getItem(LOCAL_MEMBERS_STORAGE_KEY) || '{}');
    const saved = storedUsers[email];
    if (saved) {
      profile = { ...deserializeMember(saved, email), lastLoginAt: now };
    } else {
      profile = { ...createUserProfile(email), lastLoginAt: now };
    }
    persistMemberToLocalStorage(profile);
    setMembers(loadMembersFromLocalStorage());
    setUserProfile(profile);
    setIsLoggedIn(true);
    localStorage.setItem(SESSION_STORAGE_KEY, email);
    localStorage.setItem(LAST_EMAIL_STORAGE_KEY, email);
    return true;
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const sessionEmail = localStorage.getItem(SESSION_STORAGE_KEY);
      if (sessionEmail) {
        await loginWithEmail(sessionEmail);
      }
      if (!cancelled) setSessionBootstrapped(true);
    })();
    return () => { cancelled = true; };
  }, []);

  const handleToggleExpand = (id: string) => {
    setExpandedTaskId(prev => prev === id ? null : id);
  };

  const handleLogin = async (email?: string): Promise<boolean> => {
    if (!email) return false;
    return loginWithEmail(email);
  };

  const handleLogout = () => {
    setIsLoggedIn(false);
    setUserProfile(DEFAULT_USER_PROFILE);
    localStorage.removeItem(SESSION_STORAGE_KEY);
  };

  const sendSlackWebhook = async (text: string) => {
    const webhookUrl = import.meta.env.VITE_SLACK_WEBHOOK_URL;
    if (!webhookUrl) return;
    try {
      await fetch(webhookUrl, {
        method: 'POST',
        body: JSON.stringify({ text }),
        mode: 'no-cors', // Slack Webhook は CORS を許可していないため no-cors が必要
      });
      console.log('Slack webhook sent successfully (no-cors)');
    } catch (e) {
      console.error('Slack webhook failed:', e);
    }
  };

  const sendEmailNotification = async (message: string) => {
    const emails = members.map(m => m.id).filter(email => email && email.includes('@'));
    if (emails.length === 0) return;

    try {
      await fetch('/api/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emails,
          subject: `SyncTask Notification: ${userProfile.displayName} Action`,
          message
        })
      });
      console.log('Email notification requested');
    } catch (e) {
      console.error('Email notification failed:', e);
    }
  };


  const addNotification = (type: Notification['type'], taskTitle: string) => {
    const newNotif: Notification = {
      id: Math.random().toString(36).substr(2, 9),
      userId: userProfile.id,
      userName: userProfile.displayName,
      type,
      taskTitle,
      timestamp: new Date()
    };
    setNotifications(prev => [newNotif, ...prev].slice(0, 50));

    const nowStr = format(new Date(), 'HH:mm');
    let actionStr = '';
    if (type === 'start') actionStr = `[${nowStr}] 開始しました: ${taskTitle}`;
    if (type === 'end') actionStr = `[${nowStr}] 完了しました: ${taskTitle}`;
    if (type === 'assigned') actionStr = `[${nowStr}] ${taskTitle}`;
    if (type === 'fight') actionStr = `[${nowStr}] ${taskTitle}`;
    if (type === 'paused') actionStr = `[${nowStr}] 中断しました: ${taskTitle}`;
    
    if (actionStr) {
      showToast(actionStr);
      
      const slackMessage = `🚀 *SyncTask通知*\n*ユーザー:* ${userProfile.displayName}\n*アクション:* ${actionStr}`;
      sendSlackWebhook(slackMessage);
      sendEmailNotification(slackMessage);

      if (userProfile.slackUid) {
        console.log(`[Slack Notification -> ${userProfile.slackUid}] ${actionStr}`);
      }
    }
  };

  const startTask = (taskId: string) => {
    setPendingStartTaskId(taskId);
    setShowPhotoModal(true);
  };

  const finalizeStartTask = async (taskId: string, photoUrl?: string) => {
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;
    const startedAt = new Date();
    const updatedTask = { ...task, status: 'doing' as const, startPhoto: photoUrl, updatedAt: startedAt, startedAt };
    setTasks(prev => prev.map(t => t.id === taskId ? updatedTask : t));
    setTimerSeconds(task.estimatedMinutes * 60);
    setShowPhotoModal(false);
    setPendingStartTaskId(null);
    setActiveTab('dashboard');
    addNotification('start', task.title);
    await updateTaskInFirestore(taskId, { status: 'doing', startPhoto: photoUrl, updatedAt: startedAt, startedAt });
  };

  const [expansionSignals, setExpansionSignals] = useState<Record<string, number>>({});

  const pauseTask = async (taskId: string, status: TaskStatus) => {
    const task = tasks.find(t => t.id === taskId);
    const updatedTask = task ? { ...task, status, updatedAt: new Date() } : undefined;
    setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status } : t));
    if (updatedTask) await updateTaskInFirestore(taskId, { status, updatedAt: new Date() });
    setShowRescueModal(false);
    if (task) addNotification('paused', task.title); // 通知リストにのみ追加され、Slackやトーストには出ない
  };

  const resumeTask = async (taskId: string) => {
    const task = tasks.find(t => t.id === taskId);
    const startedAt = task?.startedAt || new Date();
    setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: 'doing' as const, startedAt } : t));
    if (task) await updateTaskInFirestore(taskId, { status: 'doing', updatedAt: new Date(), startedAt });
  };

  const completeTask = (taskId: string) => {
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;

    const estimated = task.estimatedMinutes;
    const actual = Math.floor((estimated * 60 - timerSeconds) / 60);
    const gap = Math.abs(estimated - actual) / (estimated || 1);

    if (gap >= 0.2) {
      setPendingCompleteTask({ ...task, actualMinutes: actual });
      setShowGapModal(true);
    } else {
      finalizeTask(taskId, actual);
    }
  };

  const finalizeTask = async (taskId: string, actual: number, reason: string = '') => {
    const task = tasks.find(t => t.id === taskId);
    setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: 'done', actualMinutes: actual, mismatchReason: reason } : t));
    await updateTaskInFirestore(taskId, { status: 'done', actualMinutes: actual, mismatchReason: reason, updatedAt: new Date() });
    setShowGapModal(false);
    if (task) addNotification('end', task.title);
    confetti({
      particleCount: 150,
      spread: 70,
      origin: { y: 0.6 }
    });
  };

  const handleReaction = async (userId: string) => {
    setReactionSent(prev => ({ ...prev, [userId]: true }));
    setTimeout(() => {
      setReactionSent(prev => ({ ...prev, [userId]: false }));
    }, 1500);

    const targetMember = members.find(m => m.id === userId);
    if (targetMember) {
      const activeTask = tasks.find(t => t.userId === userId && t.status === 'doing');
      if (activeTask) {
         const newFights = [...(activeTask.fights || []), { senderId: userProfile.id, timestamp: Date.now() }];
         await updateTaskInFirestore(activeTask.id, { fights: newFights });
      }

      const newCount = (targetMember.fightCount || 0) + 1;
      await saveMemberToFirestore({ id: targetMember.id, fightCount: newCount });
    }
  };

  const handleDeleteTask = async (taskId: string) => {
    if (confirm('このタスクを削除してもよろしいですか？（サブタスクもすべて削除されます）')) {
      const getDescendantIds = (id: string, all: Task[]): string[] => {
        const children = all.filter(t => t.parentId === id);
        let ids = children.map(c => c.id);
        children.forEach(c => {
          ids = [...ids, ...getDescendantIds(c.id, all)];
        });
        return ids;
      };

      const idsToDelete = [taskId, ...getDescendantIds(taskId, tasks)];
      setTasks(prev => prev.filter(t => !idsToDelete.includes(t.id)));
      await Promise.all(idsToDelete.map(id => deleteTaskFromFirestore(id)));
      setShowTaskForm(false);
      setEditingTask(null);
      setTargetParentId(null);
    }
  };

  const handleTaskSubmit = async (taskData: Partial<Task>) => {
    if (editingTask) {
      const updatedTask = { ...editingTask, ...taskData, updatedAt: new Date() };
      setTasks(prev => prev.map(t => t.id === editingTask.id ? updatedTask : t));
      await updateTaskInFirestore(editingTask.id, updatedTask);
    } else {
      const parentIdForNewTask = taskData.parentId || targetParentId;
      const newId = createId();
      const newTask: Task = {
        id: newId,
        userId: userProfile.id,
        assignedBy: userProfile.id,
        parentId: parentIdForNewTask || null,
        title: taskData.title || '',
        description: taskData.description || '',
        priority: taskData.priority || 'medium',
        category: taskData.category || '作業',
        estimatedMinutes: taskData.estimatedMinutes || 30,
        actualMinutes: 0,
        status: 'todo',
        mismatchReason: '',
        attachments: taskData.attachments || [],
        dueDate: taskData.dueDate || new Date(),
        updatedAt: new Date(),
      };
      setTasks(prev => [newTask, ...prev]);
      await saveTaskToFirestore(newTask);
      setLastCreatedTaskId(newId);
      setTimeout(() => setLastCreatedTaskId(null), 2000);
      
      if (parentIdForNewTask) {
        setExpandedTaskId(parentIdForNewTask);
        // Ensure parent is expanded
        setExpansionSignals(prev => ({ ...prev, [parentIdForNewTask]: (prev[parentIdForNewTask] || 0) + 1 }));
      }
    }
    setShowTaskForm(false);
    setEditingTask(null);
    setTargetParentId(null);
  };

  const handleEditTask = (task: Task) => {
    setEditingTask(task);
    setTargetParentId(null);
    setShowTaskForm(true);
  };

  const handleAddSubtask = (parentId: string) => {
    setEditingTask(null);
    setTargetParentId(parentId);
    setShowTaskForm(true);
    // Signal for expansion
    setExpansionSignals(prev => ({ ...prev, [parentId]: (prev[parentId] || 0) + 1 }));
  };

  const assignedFromOthers = useMemo(
    () => currentUserTasks.filter(
      t => t.assignedBy && normalizeEmail(t.assignedBy) !== normalizeEmail(userProfile.id) && t.status !== 'done' && !t.parentId
    ),
    [currentUserTasks, userProfile.id]
  );

  const pendingTaskCount = useMemo(
    () => currentUserTasks.filter(t => t.status !== 'done' && !t.parentId).length,
    [currentUserTasks]
  );

  const completedTaskCount = useMemo(
    () => currentUserTasks.filter(t => t.status === 'done').length,
    [currentUserTasks]
  );

  const groupedTasks = useMemo(() => {
    const list = showCompleted ? currentUserTasks.filter(t => t.status === 'done') : currentUserTasks.filter(t => t.status !== 'done' && !t.parentId);
    
    // Sort by due date (fallback to Date.now() for missing/invalid dates to prevent NaN sort bugs)
    const sorted = [...list].sort((a, b) => {
      const timeA = a.dueDate ? new Date(a.dueDate).getTime() : Date.now();
      const timeB = b.dueDate ? new Date(b.dueDate).getTime() : Date.now();
      return (isNaN(timeA) ? Date.now() : timeA) - (isNaN(timeB) ? Date.now() : timeB);
    });
    
    const groups: Record<string, Task[]> = {};
    sorted.forEach(t => {
      const d = t.dueDate ? new Date(t.dueDate) : new Date();
      if (isNaN(d.getTime())) d.setTime(Date.now());
      
      let label = format(d, 'M/d (E)', { locale: ja });
      if (isToday(d)) label = '今日 - ' + label;
      else if (isTomorrow(d)) label = '明日 - ' + label;
      
      if (!groups[label]) groups[label] = [];
      groups[label].push(t);
    });
    return groups;
  }, [currentUserTasks, showCompleted]);

  if (!sessionBootstrapped) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <div className="text-center space-y-3">
          <div className="w-10 h-10 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-sm text-slate-500 font-medium">読み込み中...</p>
        </div>
      </div>
    );
  }

  if (!isLoggedIn) return <LoginScreen onLogin={handleLogin} isFirestoreEnabled={IS_FIRESTORE_CONFIGURED} />;

  return (
    <div className="min-h-screen font-sans text-slate-800 bg-slate-50">
      <div className="min-h-screen flex overflow-x-hidden bg-white">
        
        <Sidebar
          sidebarOpen={sidebarOpen}
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          userProfile={userProfile}
          onLogout={handleLogout}
          onClose={() => setSidebarOpen(false)}
          unreadMessageCount={unreadMessageCount}
        />

        {sidebarOpen && (
          <button
            type="button"
            aria-label="メニューを閉じる"
            className="fixed inset-0 z-30 bg-slate-900/50 lg:hidden"
            onClick={() => setSidebarOpen(false)}
          />
        )}

        {/* Main Content */}
        <main className={cn(
          "flex-1 transition-all duration-300 lg:ml-64 w-full h-screen overflow-y-auto scrollbar-hide bg-slate-50",
          !sidebarOpen && "ml-0"
        )}>
          <header className="sticky top-0 z-30 bg-white/95 backdrop-blur-md border-b border-slate-200 p-3 sm:p-4 flex items-center gap-2 sm:gap-4 min-w-0">
            {!sidebarOpen && (
              <div className="flex items-center gap-3">
                <button 
                  onClick={() => setSidebarOpen(true)}
                  className="p-2 bg-white rounded-xl shadow-sm hover:bg-slate-50 transition-all border border-slate-200"
                >
                  <Menu size={20} />
                </button>
                <div 
                  className="w-8 h-8 rounded-full overflow-hidden border border-slate-200 bg-indigo-100 cursor-pointer flex items-center justify-center text-xs font-bold text-indigo-700"
                  onClick={() => setActiveTab('settings')}
                >
                  {userProfile.avatarUrl ? (
                    <img src={userProfile.avatarUrl} className="w-full h-full object-cover" alt="" referrerPolicy="no-referrer" />
                  ) : (
                    userProfile.displayName.charAt(0).toUpperCase()
                  )}
                </div>
              </div>
            )}
            <h1 className="text-base sm:text-xl font-bold truncate min-w-0 flex-1 text-slate-900">
              {activeTab === 'dashboard' ? 'ホーム' : 
               activeTab === 'members' ? 'メンバー' :
               activeTab === 'calendar' ? 'カレンダー' : 
               activeTab === 'settings' ? '設定' : 'メッセージ'}
            </h1>
            <div className="flex shrink-0 justify-end gap-2 sm:gap-3">
              <div className="relative">
                <button 
                  onClick={() => setShowNotifications(!showNotifications)}
                  className={cn(
                    "p-2 text-slate-500 hover:bg-white/50 rounded-full transition-all relative",
                    showNotifications && "bg-indigo-50 text-indigo-600"
                  )}
                >
                  <Bell size={20} />
                  {notifications.length > 0 && (
                    <span className="absolute top-2 right-2 w-2 h-2 bg-red-500 rounded-full border-2 border-white"></span>
                  )}
                </button>
                <AnimatePresence>
                  {showNotifications && (
                    <>
                      <div className="fixed inset-0 z-40" onClick={() => setShowNotifications(false)} />
                      <motion.div 
                        initial={{ opacity: 0, y: 10, scale: 0.95 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 10, scale: 0.95 }}
                        className="absolute right-0 mt-2 w-[min(20rem,calc(100vw-1.5rem))] bg-white rounded-3xl shadow-2xl border border-slate-100 py-4 z-50 overflow-hidden"
                      >
                        <div className="px-6 pb-2 mb-2 border-b border-slate-50 flex items-center justify-between">
                           <h3 className="text-sm font-black uppercase tracking-widest text-slate-400">通知</h3>
                           <button onClick={() => setNotifications([])} className="text-[10px] text-indigo-500 font-bold hover:underline">クリア</button>
                        </div>
                        <div className="max-h-[300px] overflow-y-auto px-2">
                          {notifications.length === 0 ? (
                            <div className="py-8 text-center text-slate-400 text-xs">新しい通知はありません</div>
                          ) : (
                            notifications.map(n => (
                              <div key={n.id} className="p-3 hover:bg-slate-50 rounded-2xl flex gap-3 transition-colors">
                                 <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-600 shrink-0">
                                    {n.type === 'start' ? <Play size={14} fill="currentColor" /> : n.type === 'end' ? <CheckCircle2 size={14} /> : <Pause size={14} />}
                                 </div>
                                 <div>
                                    <div className="text-xs font-bold text-slate-800">{n.userName} が{n.type === 'start' ? '開始' : n.type === 'end' ? '完了' : '中断'}しました</div>
                                    <div className="text-[10px] text-slate-400 mt-0.5">{n.taskTitle}</div>
                                 </div>
                              </div>
                            ))
                          )}
                        </div>
                      </motion.div>
                    </>
                  )}
                </AnimatePresence>
              </div>
              <button 
                onClick={() => setShowTaskForm(true)}
                className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-3 sm:px-4 py-2 rounded-xl font-medium transition-all shadow-md active:scale-95 shrink-0"
              >
                <Plus size={18} />
                <span className="hidden sm:inline">タスク追加</span>
              </button>
            </div>
          </header>

          <div className="p-4 md:p-6 max-w-3xl mx-auto w-full">
            {activeTab === 'dashboard' && (
              <div className="space-y-5">
                {isLocked && activeTask && (
                  <motion.div 
                    initial={{ y: -12, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    className="bg-white border border-indigo-200 border-l-4 border-l-indigo-500 rounded-2xl p-5 shadow-sm"
                  >
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                      <div className="flex-1 min-w-0 space-y-1">
                        <p className="text-xs font-semibold text-indigo-600 flex items-center gap-1.5">
                          <Clock size={14} />
                          {activeTask.status === 'doing' ? '集中中のタスク' : '一時中断中'}
                        </p>
                        <h2 className="text-lg font-bold text-slate-900 truncate">{activeTask.title}</h2>
                        <span className="inline-block text-xs font-medium text-slate-500 bg-slate-100 px-2 py-0.5 rounded-md">
                          {activeTask.category}
                        </span>
                      </div>
                      <div className="flex items-center gap-4 shrink-0">
                        <div className="text-3xl font-mono font-bold text-slate-900 tabular-nums">
                          {Math.floor(timerSeconds / 60)}:{String(timerSeconds % 60).padStart(2, '0')}
                        </div>
                        <div className="flex gap-2">
                          {activeTask.status === 'doing' ? (
                            <button 
                              onClick={() => setShowRescueModal(true)}
                              className="p-2.5 bg-slate-100 hover:bg-slate-200 rounded-xl text-slate-700 transition-all"
                              title="一時中断"
                            >
                              <Pause size={20} />
                            </button>
                          ) : (
                            <button 
                               onClick={() => resumeTask(activeTask.id)}
                               className="p-2.5 bg-indigo-600 hover:bg-indigo-700 rounded-xl text-white transition-all"
                               title="再開"
                            >
                              <Play size={20} fill="currentColor" />
                            </button>
                          )}
                          <button 
                            onClick={() => completeTask(activeTask.id)}
                            className="p-2.5 bg-emerald-600 hover:bg-emerald-700 rounded-xl text-white transition-all"
                            title="完了"
                          >
                            <CheckCircle2 size={20} />
                          </button>
                        </div>
                      </div>
                    </div>
                    <div className="mt-4 h-2 w-full bg-slate-100 rounded-full overflow-hidden">
                      <motion.div 
                        initial={{ width: '100%' }}
                        animate={{ width: `${(timerSeconds / ((activeTask.estimatedMinutes || 60) * 60)) * 100}%` }}
                        className={cn(
                          "h-full transition-colors duration-500",
                          timerSeconds < 300 ? "bg-red-500" : 
                          timerSeconds < 900 ? "bg-amber-500" : "bg-emerald-500"
                        )}
                      />
                    </div>
                  </motion.div>
                )}

                {assignedFromOthers.length > 0 && (
                  <div className="bg-indigo-50 border border-indigo-100 rounded-2xl p-4 space-y-2">
                    <p className="text-xs font-semibold text-indigo-700">届いたタスク（{assignedFromOthers.length}件）</p>
                    <ul className="space-y-1">
                      {assignedFromOthers.slice(0, 3).map(t => {
                        const from = members.find(m => normalizeEmail(m.id) === normalizeEmail(t.assignedBy));
                        return (
                          <li key={t.id} className="text-sm text-slate-700 truncate">
                            <span className="font-medium">{from?.displayName || t.assignedBy}</span>
                            {' から: '}{t.title}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}

                <div className="flex flex-wrap items-end justify-between gap-3">
                  <div>
                    <h2 className="text-2xl font-bold text-slate-900">タスク一覧</h2>
                    <p className="text-sm text-slate-500 mt-0.5">
                      {showCompleted ? `完了 ${completedTaskCount} 件` : `未完了 ${pendingTaskCount} 件`}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2 text-xs font-semibold">
                    <span className="px-3 py-1.5 bg-white border border-slate-200 rounded-full text-slate-600">
                      未完了 {pendingTaskCount}
                    </span>
                    <span className="px-3 py-1.5 bg-white border border-slate-200 rounded-full text-slate-600">
                      完了 {completedTaskCount}
                    </span>
                    {userProfile.currentStreak > 0 && (
                      <span className="px-3 py-1.5 bg-amber-50 border border-amber-100 rounded-full text-amber-800">
                        🔥 {userProfile.currentStreak}日
                      </span>
                    )}
                  </div>
                </div>

                <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                  <div className="flex border-b border-slate-100">
                    <button 
                      onClick={() => setShowCompleted(false)}
                      className={cn(
                        "flex-1 py-3.5 text-sm font-semibold transition-colors border-b-2",
                        !showCompleted 
                          ? "text-indigo-600 border-indigo-600 bg-indigo-50/50" 
                          : "text-slate-500 border-transparent hover:text-slate-700"
                      )}
                    >
                      未完了 ({pendingTaskCount})
                    </button>
                    <button 
                      onClick={() => setShowCompleted(true)}
                      className={cn(
                        "flex-1 py-3.5 text-sm font-semibold transition-colors border-b-2",
                        showCompleted 
                          ? "text-indigo-600 border-indigo-600 bg-indigo-50/50" 
                          : "text-slate-500 border-transparent hover:text-slate-700"
                      )}
                    >
                      完了 ({completedTaskCount})
                    </button>
                  </div>

                  {!showCompleted && (
                    <div className="px-4 pt-3 pb-1 flex items-center gap-2 overflow-x-auto scrollbar-hide border-b border-slate-50">
                      {['すべて', ...availableCategories].map(cat => (
                        <button
                          key={cat}
                          onClick={() => setSelectedCategory(cat)}
                          className={cn(
                            "whitespace-nowrap px-3 py-1.5 rounded-lg text-xs font-semibold transition-all shrink-0",
                            selectedCategory === cat 
                              ? "bg-indigo-600 text-white" 
                              : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                          )}
                        >
                          {cat}
                        </button>
                      ))}
                    </div>
                  )}

                  <div className="p-4 space-y-8">
                    <AnimatePresence mode="popLayout">
                      {(Object.entries(groupedTasks) as [string, Task[]][]).map(([dateLabel, dateTasks]) => {
                        const filtered = dateTasks.filter(t => selectedCategory === 'すべて' || t.category === selectedCategory);
                        if (filtered.length === 0) return null;
                        return (
                          <motion.section 
                            key={dateLabel}
                            initial={{ opacity: 0, y: 8 }}
                            animate={{ opacity: 1, y: 0 }}
                            className="space-y-3"
                          >
                            <div className="flex items-center gap-2 text-slate-500">
                              <CalendarIcon size={15} />
                              <h3 className="text-xs font-bold uppercase tracking-wide">{dateLabel}</h3>
                              <span className="text-xs text-slate-400">({filtered.length})</span>
                            </div>
                            <ul className="space-y-2 list-none">
                              {filtered.map(task => (
                                <li key={task.id}>
                                  <TaskCard 
                                    task={task} 
                                    disabled={isLocked && activeTaskId !== task.id}
                                    onStart={startTask}
                                    onEdit={handleEditTask}
                                    onAddSubtask={handleAddSubtask}
                                    isLocked={isLocked && activeTaskId === task.id}
                                    allTasks={tasks}
                                    onImageClick={(url) => setPreviewImage(url)}
                                    expansionSignals={expansionSignals}
                                    isExpanded={expandedTaskId === task.id}
                                    onToggleExpand={handleToggleExpand}
                                    lastCreatedTaskId={lastCreatedTaskId}
                                  />
                                </li>
                              ))}
                            </ul>
                          </motion.section>
                        );
                      })}
                    </AnimatePresence>

                    {currentUserTasks.filter(t => showCompleted ? (t.status === 'done') : (t.status !== 'done' && !t.parentId)).length === 0 && (
                      <div className="py-16 text-center rounded-xl border-2 border-dashed border-slate-200 bg-slate-50">
                        {showCompleted ? (
                          <>
                            <CheckCircle2 className="mx-auto text-slate-300 mb-3" size={40} />
                            <p className="text-slate-600 font-semibold">完了したタスクはまだありません</p>
                          </>
                        ) : (
                          <div className="space-y-4 max-w-xs mx-auto px-4">
                            <p className="text-slate-700 font-semibold">タスクがありません</p>
                            <p className="text-sm text-slate-500 leading-relaxed">
                              右上の「＋」から、今日やることを追加しましょう。
                            </p>
                            <button 
                              onClick={() => setShowTaskForm(true)}
                              className="w-full px-5 py-3 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl font-semibold transition-all active:scale-95"
                            >
                              タスクを追加
                            </button>
                          </div>
                        )}
                      </div>
                    )}

                    {!showCompleted && pendingTaskCount > 0 && (Object.entries(groupedTasks) as [string, Task[]][]).every(([, tasks]) => 
                      tasks.filter(t => selectedCategory === 'すべて' || t.category === selectedCategory).length === 0
                    ) && (
                      <div className="py-12 text-center text-sm text-slate-500">
                        このカテゴリのタスクはありません
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'calendar' && (
              <CalendarView 
                tasks={tasks} 
                onDayClick={(date) => {
                  setEditingTask(null);
                  setTargetParentId(null);
                  setShowTaskForm(true);
                }} 
              />
            )}

            {activeTab === 'messages' && (
               <MessagesView 
                 members={members} 
                 tasks={tasks} 
                 currentUser={userProfile}
                 onShareNewTask={() => {
                   setEditingTask(null);
                   setTargetParentId(null);
                   setShowTaskForm(true);
                 }}
                 onAssignTask={async (task, targetUserId) => {
                   const assignedTask = buildAssignedTaskCopy(task, targetUserId, userProfile.id);
                   setTasks(prev => [...prev, assignedTask]);
                   try {
                     await saveTaskToFirestore(assignedTask);
                   } catch {
                     showToast('タスクの送信に失敗しました。接続を確認してください。');
                     setTasks(prev => prev.filter(t => t.id !== assignedTask.id));
                     throw new Error('assign failed');
                   }
                   const target = members.find(m => m.id === targetUserId);
                   showToast(`${target?.displayName || '相手'}にタスクを送りました`);
                   return assignedTask;
                 }}
                 globalMessages={chatMessages}
                 onSendMessage={(msg) => {
                   const normalized: ChatMessage = {
                     ...msg,
                     senderId: normalizeEmail(msg.senderId),
                     receiverId: normalizeEmail(msg.receiverId)
                   };
                   setChatMessages(prev =>
                     [...prev.filter(m => m.id !== normalized.id), normalized].sort(
                       (a, b) => a.timestamp.getTime() - b.timestamp.getTime()
                     )
                   );
                   saveMessageToFirestore(normalized).catch(() => {
                     showToast('メッセージの送信に失敗しました');
                   });
                 }}
                 onDeleteMessage={(id) => {
                   setChatMessages(prev => prev.filter(m => m.id !== id));
                   deleteMessageFromFirestore(id);
                 }}
               />
            )}

            {activeTab === 'members' && (
               <div className="max-w-3xl mx-auto space-y-6">
                  <div>
                    <h2 className="text-xl font-bold text-slate-900">チームメンバー</h2>
                    <p className="text-sm text-slate-500 mt-1">
                      {members.length}人が登録済み（ログインした全員が表示されます）
                    </p>
                  </div>

                  {/* 実行中メンバー バナー */}
                  {memberProgress.some(p => p.status === 'doing') && (
                    <div className="space-y-3">
                      <p className="text-xs font-black text-indigo-500 uppercase tracking-widest px-1 flex items-center gap-1.5">
                        <span className="w-2 h-2 bg-indigo-500 rounded-full animate-pulse inline-block" />
                        集中中のメンバー
                      </p>
                      {memberProgress.filter(p => p.status === 'doing').map(p => {
                        const elapsed = p.elapsedMinutes;
                        const elapsedSec = elapsed * 60 + progressTick % 60;
                        const displayMin = Math.floor(elapsedSec / 60);
                        const displaySec = elapsedSec % 60;
                        return (
                          <motion.div
                            key={p.userId}
                            initial={{ y: -8, opacity: 0 }}
                            animate={{ y: 0, opacity: 1 }}
                            className="bg-white border border-indigo-200 border-l-4 border-l-indigo-500 rounded-2xl p-4 sm:p-5 shadow-sm cursor-pointer hover:shadow-md transition-all"
                            onClick={() => { setSelectedMemberId(p.userId); setShowMemberDetail(true); }}
                          >
                            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                              <div className="flex items-center gap-3 min-w-0 flex-1">
                                <div className="w-10 h-10 rounded-full overflow-hidden bg-indigo-100 flex items-center justify-center text-sm font-bold ring-2 ring-indigo-400 shrink-0">
                                  {(p.member.avatarUrl || p.member.backgroundImageUrl) ? (
                                    <img src={p.member.avatarUrl || p.member.backgroundImageUrl} className="w-full h-full object-cover" alt="" referrerPolicy="no-referrer" />
                                  ) : p.member.displayName[0]}
                                </div>
                                {p.startPhoto && (
                                  <div className="w-10 h-10 rounded-lg overflow-hidden border-2 border-indigo-100 shrink-0 cursor-zoom-in" onClick={e => { e.stopPropagation(); setPreviewImage(p.startPhoto!); }}>
                                    <img src={p.startPhoto} className="w-full h-full object-cover" alt="" />
                                  </div>
                                )}
                                <div className="min-w-0 flex-1 space-y-0.5">
                                  <p className="text-xs font-semibold text-indigo-600 flex items-center gap-1">
                                    <Clock size={12} />
                                    {p.member.displayName} が集中中
                                  </p>
                                  <h3 className="text-base font-bold text-slate-900 truncate">{p.taskTitle}</h3>
                                  {p.activeTask && (
                                    <span className="inline-block text-xs font-medium text-slate-500 bg-slate-100 px-2 py-0.5 rounded-md">{p.activeTask.category}</span>
                                  )}
                                </div>
                              </div>
                              <div className="flex items-center gap-3 shrink-0">
                                <div className="text-2xl font-mono font-bold text-indigo-700 tabular-nums">
                                  {String(displayMin).padStart(2, '0')}:{String(displaySec).padStart(2, '0')}
                                </div>
                                <motion.button
                                  whileTap={{ scale: 0.9 }}
                                  onClick={e => { e.stopPropagation(); handleReaction(p.userId); }}
                                  className={cn(
                                    "p-3 rounded-2xl transition-all flex flex-col items-center gap-1 min-w-[56px]",
                                    reactionSent[p.userId] ? "bg-indigo-600 text-white" : "bg-slate-50 text-slate-600 hover:bg-slate-100 border border-slate-200"
                                  )}
                                >
                                  <ThumbsUp size={16} className={cn(reactionSent[p.userId] && "animate-bounce")} />
                                  <span className="text-[9px] font-black italic">Fight!</span>
                                </motion.button>
                              </div>
                            </div>
                            <div className="mt-3 h-2 w-full bg-slate-100 rounded-full overflow-hidden">
                              <motion.div
                                initial={{ width: 0 }}
                                animate={{ width: `${p.progress}%` }}
                                className="h-full bg-indigo-500 transition-all"
                              />
                            </div>
                            <div className="mt-1 flex justify-between text-[10px] text-slate-400 font-medium">
                              <span>経過 {displayMin}分</span>
                              {p.activeTask && <span>目安 {p.activeTask.estimatedMinutes}分</span>}
                            </div>
                          </motion.div>
                        );
                      })}
                    </div>
                  )}

                  <div className="space-y-4 px-2">
                    {memberProgress.length === 0 ? (
                      <div className="py-16 text-center rounded-2xl border border-dashed border-slate-200 bg-white">
                        <User className="mx-auto text-slate-300 mb-3" size={40} />
                        <p className="text-slate-600 font-semibold">まだメンバーがいません</p>
                        <p className="text-sm text-slate-500 mt-2 max-w-xs mx-auto">
                          アプリのURLを共有し、それぞれのメールアドレスでログインしてもらうとここに表示されます。
                        </p>
                      </div>
                    ) : memberProgress.map((progressItem) => (
                        <div key={progressItem.userId} className="bg-white p-4 sm:p-6 rounded-[24px] sm:rounded-[32px] shadow-sm border border-slate-100 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6 transition-all hover:shadow-md cursor-pointer" onClick={() => { setSelectedMemberId(progressItem.userId); setShowMemberDetail(true); }}>
                          <div className="flex items-center gap-4 flex-1 min-w-0">
                             <div className={cn(
                                "w-12 h-12 rounded-full overflow-hidden bg-slate-200 flex items-center justify-center text-xs font-bold ring-2 ring-white shadow-sm shrink-0",
                                progressItem.status === 'doing' && "ring-indigo-500"
                              )}>
                                 {(progressItem.member.avatarUrl || progressItem.member.backgroundImageUrl) ? (
                                   <img src={progressItem.member.avatarUrl || progressItem.member.backgroundImageUrl} className="w-full h-full object-cover" alt="" referrerPolicy="no-referrer" />
                                 ) : progressItem.member.displayName.split(' ').map(n => n[0]).join('')}
                              </div>
                             <div className="min-w-0 flex-1">
                               <div className="flex items-center gap-3 min-w-0 flex-1">
                                  <div className="flex flex-col min-w-0">
                                    <div className="text-sm font-bold text-slate-800 truncate">{progressItem.member.displayName}</div>
                                    <div className="text-xs text-slate-400 truncate">{progressItem.member.id}</div>
                                  </div>
                                  {progressItem.startPhoto && (
                                    <div 
                                      className="w-10 h-10 rounded-lg overflow-hidden border-2 border-indigo-100 shrink-0 hover:ring-2 hover:ring-indigo-400 transition-all cursor-zoom-in"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setPreviewImage(progressItem.startPhoto!);
                                      }}
                                    >
                                      <img src={progressItem.startPhoto} className="w-full h-full object-cover" alt="Member Task" />
                                    </div>
                                  )}
                               </div>
                               <div className={cn(
                                  "text-[10px] font-bold mt-1 inline-block px-2 py-0.5 rounded uppercase tracking-tighter",
                                  progressItem.status === 'doing' ? "text-indigo-700 bg-indigo-50" :
                                  progressItem.status === 'waiting' ? "text-amber-700 bg-amber-50" : "text-slate-500 bg-slate-100"
                               )}>
                                  {progressItem.status === 'doing' ? '実行中' : progressItem.status === 'waiting' ? `待機中（${progressItem.pendingCount}件）` : 'タスクなし'}
                               </div>
                             </div>
                          </div>
                          
                          <div className="flex items-center gap-3 sm:flex-1 sm:min-w-0 w-full">
                            <div className="flex-1 min-w-0 space-y-1">
                               {progressItem.status === 'doing' ? (
                                 <>
                                   <div className="text-sm font-semibold text-slate-800 truncate">{progressItem.taskTitle}</div>
                                   <div className="text-xs text-indigo-600 font-medium">
                                     開始から {progressItem.elapsedMinutes} 分経過
                                     {progressItem.activeTask && (
                                       <span className="text-slate-500"> / 目安 {progressItem.activeTask.estimatedMinutes} 分</span>
                                     )}
                                   </div>
                                 </>
                               ) : progressItem.status === 'waiting' ? (
                                 <>
                                   <div className="text-sm font-medium text-slate-700 truncate">次: {progressItem.taskTitle}</div>
                                   <div className="text-xs text-slate-500">未完了タスク {progressItem.pendingCount} 件</div>
                                 </>
                               ) : (
                                 <div className="text-xs text-slate-400">進行中のタスクはありません</div>
                               )}
                               <div className="h-2 w-full bg-slate-100 rounded-full overflow-hidden">
                                  <motion.div 
                                    initial={{ width: 0 }}
                                    animate={{ width: `${progressItem.progress}%` }}
                                    className={cn(
                                      "h-full transition-all",
                                      progressItem.status === 'doing' ? "bg-indigo-500" : "bg-slate-300"
                                    )}
                                  />
                               </div>
                            </div>

                            <motion.button 
                              whileTap={{ scale: 0.9 }}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleReaction(progressItem.userId);
                              }}
                              className={cn(
                                "p-3 rounded-2xl transition-all flex flex-col items-center gap-1 min-w-[60px] shrink-0",
                                reactionSent[progressItem.userId] ? "bg-indigo-600 text-white" : "bg-slate-50 text-slate-600 hover:bg-slate-100 border border-slate-200"
                              )}
                            >
                              <ThumbsUp size={18} className={cn(reactionSent[progressItem.userId] && "animate-bounce")} />
                              <span className="text-[9px] font-black italic">Fight!</span>
                            </motion.button>
                          </div>
                        </div>
                    ))}
                  </div>
               </div>
            )}

            {activeTab === 'settings' && (
              <div className="max-w-2xl mx-auto bg-white rounded-2xl shadow-sm p-4 sm:p-8 border border-slate-200 space-y-8">
                 <h2 className="text-xl font-bold text-slate-900">設定</h2>
                 <div className="space-y-6">
                    <div>
                       <label className="text-sm font-semibold text-slate-700 block mb-4">プロフィール</label>
                       <div className="space-y-4">
                          <div className="flex flex-col gap-1.5">
                             <span className="text-xs font-medium text-slate-500">ログイン中のアカウント</span>
                             <p className="text-sm text-slate-700 bg-slate-50 border border-slate-200 rounded-xl px-4 py-3">{userProfile.id}</p>
                          </div>
                          <div className="flex flex-col gap-1.5">
                             <span className="text-xs font-medium text-slate-500">表示名</span>
                             <input 
                                type="text"
                                value={userProfile.displayName}
                                onChange={(e) => setUserProfile({...userProfile, displayName: e.target.value})}
                                className="bg-slate-50 border border-slate-200 rounded-xl text-sm px-4 py-3 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-300 outline-none"
                             />
                          </div>
                          <div className="flex flex-col gap-2">
                             <span className="text-xs font-medium text-slate-500">アイコン</span>
                             <div className="flex gap-4 items-center">
                                <div className="w-16 h-16 rounded-2xl bg-indigo-50 shrink-0 overflow-hidden border border-slate-200 flex items-center justify-center text-lg font-bold text-indigo-700">
                                   {userProfile.avatarUrl ? (
                                     <img src={userProfile.avatarUrl} className="w-full h-full object-cover" alt="" referrerPolicy="no-referrer" />
                                   ) : (
                                     userProfile.displayName.charAt(0).toUpperCase()
                                   )}
                                </div>
                                <div className="flex-1">
                                   <button 
                                     onClick={() => document.getElementById('avatar-upload')?.click()}
                                     className="w-full py-2.5 bg-indigo-600 text-white text-sm font-semibold rounded-xl hover:bg-indigo-700 transition-all"
                                   >
                                     写真を変更
                                   </button>
                                   <input 
                                     id="avatar-upload"
                                     type="file"
                                     accept="image/*"
                                     className="hidden"
                                     onChange={(e) => {
                                       const file = e.target.files?.[0];
                                       if (file) {
                                         const reader = new FileReader();
                                         reader.onload = (ev) => setUserProfile({...userProfile, avatarUrl: ev.target?.result as string});
                                         reader.readAsDataURL(file);
                                       }
                                     }}
                                   />
                                </div>
                             </div>
                          </div>
                       </div>
                    </div>

                    <div className="pt-6 border-t border-slate-100">
                       <label className="text-sm font-bold text-slate-600 block mb-4">デフォルトカテゴリーの管理</label>
                       <div className="flex flex-wrap gap-2 mb-4">
                          {availableCategories.map(cat => (
                            <div key={cat} className="group relative">
                               <span className="inline-flex items-center gap-2 px-4 py-2 bg-slate-50 text-slate-700 text-xs font-bold rounded-xl border border-slate-200">
                                  {cat}
                                  <button 
                                    onClick={() => setAvailableCategories(prev => prev.filter(c => c !== cat))}
                                    className="text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all"
                                  >
                                    <X size={12} />
                                  </button>
                               </span>
                            </div>
                          ))}
                       </div>
                       <div className="flex gap-2">
                          <input 
                            id="newCategoryInput"
                            type="text" 
                            placeholder="新しいカテゴリー名..."
                            className="flex-1 bg-slate-50 border-none rounded-xl text-xs px-4 py-3 focus:ring-2 focus:ring-indigo-500"
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                const val = (e.target as HTMLInputElement).value;
                                if (val && !availableCategories.includes(val)) {
                                  setAvailableCategories(prev => [...prev, val]);
                                  (e.target as HTMLInputElement).value = '';
                                }
                              }
                            }}
                          />
                          <button 
                            onClick={() => {
                              const input = document.getElementById('newCategoryInput') as HTMLInputElement;
                              const val = input.value;
                              if (val && !availableCategories.includes(val)) {
                                setAvailableCategories(prev => [...prev, val]);
                                input.value = '';
                              }
                            }}
                            className="bg-indigo-600 text-white px-4 py-2 rounded-xl text-xs font-bold"
                          >追加</button>
                       </div>
                    </div>

                    {userProfile.badges.length > 0 && (
                    <div className="pt-6 border-t border-slate-100">
                       <label className="text-sm font-semibold text-slate-700 block mb-3">バッジ</label>
                       <div className="flex flex-wrap gap-2">
                          {userProfile.badges.map(b => (
                            <span key={b} className="px-3 py-1.5 bg-indigo-50 text-indigo-700 text-xs font-semibold rounded-lg border border-indigo-100">
                               {b}
                            </span>
                          ))}
                       </div>
                    </div>
                    )}

                    <div className="pt-6 border-t border-slate-100 text-center">
                       <button onClick={handleLogout} className="px-6 py-3 bg-red-50 text-red-600 text-sm font-bold rounded-2xl hover:bg-red-100 transition-all">ログアウト</button>
                    </div>
                 </div>
              </div>
            )}
          </div>
        </main>
      </div>

      <AnimatePresence>
        {showTaskForm && (
          <TaskFormModal 
            initialTask={editingTask}
            parentId={targetParentId}
            availableCategories={availableCategories}
            onClose={() => {
              setShowTaskForm(false);
              setEditingTask(null);
              setTargetParentId(null);
            }}
            onSubmit={handleTaskSubmit}
            onDelete={handleDeleteTask}
          />
        )}
        {showPhotoModal && pendingStartTaskId && (
           <PhotoCaptureModal 
             onClose={() => setShowPhotoModal(false)}
             onConfirm={(url) => finalizeStartTask(pendingStartTaskId, url)}
           />
        )}
        {showRescueModal && activeTaskId && (
           <RescueModal 
              onClose={() => setShowRescueModal(false)}
              onPause={(status) => pauseTask(activeTaskId, status)}
           />
        )}
        {showGapModal && pendingCompleteTask && (
          <GapAnalysisModal 
            task={pendingCompleteTask}
            onClose={() => setShowGapModal(false)}
            onSubmit={(reason) => finalizeTask(pendingCompleteTask.id, pendingCompleteTask.actualMinutes, reason)}
          />
        )}
        {showMemberDetail && selectedMemberId && (
           <MemberDetailModal 
             member={members.find(m => m.id === selectedMemberId)!}
             tasks={tasks}
             onClose={() => setShowMemberDetail(false)}
             onImageClick={(url) => setPreviewImage(url)}
             expansionSignals={expansionSignals}
           />
        )}
        {previewImage && (
          <ImagePreviewModal imageUrl={previewImage} onClose={() => setPreviewImage(null)} />
        )}
      </AnimatePresence>
      {/* Toast Notifications */}
      <div className="fixed bottom-4 left-4 right-4 sm:left-auto sm:right-6 sm:bottom-6 z-[300] flex flex-col gap-2 pointer-events-none items-end">
        <AnimatePresence>
          {toasts.map(toast => (
            <motion.div
              key={toast.id}
              initial={{ opacity: 0, y: 50, scale: 0.9 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              className="bg-slate-900/90 text-white px-6 py-4 rounded-2xl shadow-2xl flex items-center gap-3 border border-slate-700 pointer-events-auto"
            >
              <Bell size={18} className="text-indigo-400" />
              <span className="text-sm font-bold">{toast.message}</span>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}

function ImagePreviewModal({ imageUrl, onClose }: { imageUrl: string, onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-6 bg-slate-900/95 backdrop-blur-2xl" onClick={onClose}>
      <motion.div 
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.9, opacity: 0 }}
        className="relative max-w-4xl w-full aspect-video rounded-[48px] overflow-hidden shadow-2xl ring-8 ring-white/10"
        onClick={e => e.stopPropagation()}
      >
        <img src={imageUrl} className="w-full h-full object-cover" alt="Magnified Preview" />
        <button onClick={onClose} className="absolute top-6 right-6 p-4 bg-black/50 backdrop-blur-xl text-white rounded-full hover:bg-black/70 transition-all">
          <X size={24} />
        </button>
        <div className="absolute bottom-10 left-1/2 -translate-x-1/2 px-6 py-3 bg-black/50 backdrop-blur-xl text-white rounded-2xl text-xs font-black uppercase tracking-widest border border-white/10">
          Captured Moment
        </div>
      </motion.div>
    </div>
  );
}


// --- Sub-components ---

function LoginScreen({ onLogin, isFirestoreEnabled }: { onLogin: (email: string) => Promise<boolean>; isFirestoreEnabled: boolean }) {
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    const lastEmail = localStorage.getItem(LAST_EMAIL_STORAGE_KEY);
    if (lastEmail) {
      setEmail(lastEmail);
    }
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    const normalized = normalizeEmail(email);
    if (!normalized) {
      setError('メールアドレスを入力してください');
      return;
    }
    if (!normalized.includes('@')) {
      setError('有効なメールアドレスを入力してください');
      return;
    }

    setIsSubmitting(true);
    try {
      const ok = await onLogin(normalized);
      if (!ok) {
        setError('ログインに失敗しました。接続を確認して再度お試しください。');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-white flex items-center justify-center p-6">
      <motion.div 
        initial={{ y: 16, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        className="w-full max-w-md space-y-8 text-center"
      >
        <div className="space-y-3">
          <div className="inline-flex items-center justify-center p-3 bg-indigo-50 rounded-2xl border border-indigo-100">
            <Sparkles size={36} className="text-indigo-600" />
          </div>
          <h1 className="text-4xl font-bold text-slate-900 tracking-tight">
            Sync<span className="text-indigo-600">Task</span>
          </h1>
          <p className="text-slate-500 text-sm max-w-xs mx-auto leading-relaxed">
            シンプルなタスク管理で、チームと一緒に集中しましょう。
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-2xl p-6 sm:p-8 space-y-5 shadow-sm text-left">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-600">メールアドレス</label>
              <input 
                type="email"
                placeholder="example@email.com"
                className="w-full bg-slate-50 border border-slate-200 rounded-xl py-3.5 px-4 text-slate-900 outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-300 transition-all"
                value={email}
                onChange={e => { setEmail(e.target.value); setError(''); }}
              />
              {error && <p className="text-rose-600 text-xs font-medium">{error}</p>}
            </div>

            <button 
              type="submit"
              disabled={isSubmitting}
              className="w-full bg-indigo-600 text-white py-3.5 rounded-xl font-semibold hover:bg-indigo-700 transition-all active:scale-[0.98] disabled:opacity-60"
            >
              {isSubmitting ? 'ログイン中...' : 'ログイン'}
            </button>
          </form>

          <p className="text-xs text-slate-500 leading-relaxed">
            初回はアカウントが自動作成され、次回から同じメールでログインできます。チーム全員がメンバー一覧に表示されます。
            {!isFirestoreEnabled && (
              <span className="block mt-2 text-amber-700 font-medium">
                ※ 本番URLで全員共有するには Vercel に Firebase 環境変数の設定が必要です。
              </span>
            )}
          </p>
        </div>
      </motion.div>
    </div>
  );
}

interface SidebarItemProps {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  onClick?: () => void;
  badge?: number;
}

interface SidebarProps {
  sidebarOpen: boolean;
  activeTab: 'dashboard' | 'calendar' | 'messages' | 'members' | 'settings';
  setActiveTab: (tab: 'dashboard' | 'calendar' | 'messages' | 'members' | 'settings') => void;
  userProfile: UserProfile;
  onLogout: () => void;
  onClose: () => void;
  unreadMessageCount: number;
}

function Sidebar({ sidebarOpen, activeTab, setActiveTab, userProfile, onLogout, onClose, unreadMessageCount }: SidebarProps) {
  return (
    <aside className={cn(
      "fixed inset-y-0 left-0 z-40 w-64 bg-white/90 backdrop-blur-md border-r border-slate-200 transition-transform duration-300 transform lg:translate-x-0 shadow-2xl lg:shadow-none",
      !sidebarOpen && "-translate-x-full"
    )}>
      <div className="h-full flex flex-col p-4">
        <div className="flex items-center justify-between mb-8 px-2">
          <div className="flex items-center gap-2 text-indigo-600 font-bold text-xl italic cursor-pointer" onClick={() => { setActiveTab('dashboard'); onClose(); }}>
            <Sparkles size={28} />
            <span>SyncTask</span>
          </div>
          <button onClick={onClose} className="lg:hidden text-slate-400 hover:text-slate-600 border border-slate-200 p-1 rounded-lg">
            <X size={20} />
          </button>
        </div>

        <nav className="flex-1 space-y-2">
          <SidebarItem icon={<LayoutDashboard size={20} />} label="ホーム" active={activeTab === 'dashboard'} onClick={() => { setActiveTab('dashboard'); onClose(); }} />
          <SidebarItem icon={<User size={20} />} label="メンバー進捗" active={activeTab === 'members'} onClick={() => { setActiveTab('members'); onClose(); }} />
          <SidebarItem icon={<CalendarIcon size={20} />} label="記録・カレンダー" active={activeTab === 'calendar'} onClick={() => { setActiveTab('calendar'); onClose(); }} />
          <SidebarItem icon={<MessageSquare size={20} />} label="メッセージ" active={activeTab === 'messages'} badge={unreadMessageCount} onClick={() => { setActiveTab('messages'); onClose(); }} />
          <SidebarItem icon={<Settings size={20} />} label="設定" active={activeTab === 'settings'} onClick={() => { setActiveTab('settings'); onClose(); }} />
        </nav>

        <div className="pt-4 border-t border-slate-200">
          <div className="flex items-center gap-3 p-3 bg-slate-50 rounded-2xl border border-slate-100 mb-4 cursor-pointer" onClick={() => { setActiveTab('settings'); onClose(); }}>
            <div className="w-10 h-10 rounded-full bg-indigo-500 flex items-center justify-center text-white font-bold overflow-hidden">
               {userProfile.avatarUrl ? (
                 <img src={userProfile.avatarUrl} className="w-full h-full object-cover" alt="" referrerPolicy="no-referrer" />
               ) : userProfile.displayName.split(' ').map(n => n[0]).join('')}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold truncate">{userProfile.displayName}</div>
              <div className="text-[10px] text-slate-500 font-bold leading-none">🔥 {userProfile.currentStreak}日連続達成</div>
            </div>
          </div>
          <button 
            onClick={onLogout}
            className="w-full flex items-center gap-2 p-3 text-slate-500 hover:text-red-500 transition-colors font-bold text-sm"
          >
            <LogOut size={20} />
            <span>ログアウト</span>
          </button>
        </div>
      </div>
    </aside>
  );
}

function SidebarItem({ icon, label, active, onClick, badge }: SidebarItemProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-bold transition-all group",
        active
          ? "bg-indigo-600 text-white shadow-lg shadow-indigo-200"
          : "text-slate-500 hover:bg-slate-100 hover:text-slate-800"
      )}
    >
      <span className={cn("transition-colors", active ? "text-white" : "text-slate-400 group-hover:text-indigo-600")}>
        {icon}
      </span>
      {label}
      {!!badge && badge > 0 && (
        <span className="ml-auto bg-red-500 text-white text-[10px] font-black rounded-full min-w-[20px] h-5 flex items-center justify-center px-1 leading-none">
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </button>
  );
}

function RescueModal({ onClose, onPause }: { onClose: () => void, onPause: (s: TaskStatus) => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-slate-900/60 backdrop-blur-md" onClick={onClose}>
      <motion.div 
        initial={{ y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 20, opacity: 0 }}
        onClick={e => e.stopPropagation()}
        className="bg-white w-full max-w-md rounded-[40px] shadow-2xl p-8 space-y-6 text-center"
      >
        <div className="w-16 h-16 bg-amber-50 rounded-full flex items-center justify-center mx-auto text-amber-500 mb-2">
          <Pause size={32} />
        </div>
        <div className="space-y-1">
          <h2 className="text-2xl font-black">タスクの一時中断</h2>
          <p className="text-slate-500 text-sm font-medium">中断の理由を選択してください。</p>
        </div>

        <div className="grid grid-cols-1 gap-3">
           <button onClick={() => onPause('paused_break')} className="py-4 bg-slate-50 hover:bg-slate-100 rounded-2xl font-bold flex items-center justify-center gap-3 transition-all border border-slate-200">
             ☕ 休憩・自己研鑽
           </button>
           <button onClick={() => onPause('paused_urgent')} className="py-4 bg-rose-50 hover:bg-rose-100 rounded-2xl font-bold flex items-center justify-center gap-3 transition-all border border-rose-100 text-rose-600">
             ⚠️ 緊急の割り込み対応
           </button>
        </div>
        <button onClick={onClose} className="text-xs text-slate-400 font-bold hover:underline">戻る</button>
      </motion.div>
    </div>
  );
}

interface TaskCardProps {
  key?: string | number;
  task: Task;
  disabled?: boolean;
  onStart: (id: string) => void;
  onEdit: (task: Task) => void;
  onAddSubtask: (parentId: string) => void;
  isLocked?: boolean;
  allTasks: Task[];
  onImageClick?: (url: string) => void;
  depth?: number;
  expansionSignals?: Record<string, number>;
  isExpanded?: boolean;
  onToggleExpand?: (id: string) => void;
  lastCreatedTaskId?: string | null;
}

function TaskCard({ 
  task, 
  disabled, 
  onStart, 
  onEdit, 
  onAddSubtask, 
  isLocked, 
  allTasks, 
  onImageClick,
  depth = 0,
  expansionSignals = {},
  isExpanded: controlledIsExpanded,
  onToggleExpand,
  lastCreatedTaskId
}: TaskCardProps) {
  const [internalIsExpanded, setInternalIsExpanded] = useState(false);
  const isExpanded = controlledIsExpanded !== undefined ? controlledIsExpanded : internalIsExpanded;
  
  const toggleExpand = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onToggleExpand) {
      onToggleExpand(task.id);
    } else {
      setInternalIsExpanded(!isExpanded);
    }
  };

  const [focusedSubtaskId, setFocusedSubtaskId] = useState<string | null>(null);

  useEffect(() => {
    if (lastCreatedTaskId) {
      const subtask = allTasks.find(t => t.id === lastCreatedTaskId && t.parentId === task.id);
      if (subtask) {
        setFocusedSubtaskId(lastCreatedTaskId);
      }
    }
  }, [lastCreatedTaskId, task.id, allTasks]);

  const lastHandledSignal = useRef(0);

  useEffect(() => {
    const currentSignal = expansionSignals[task.id] || 0;
    if (currentSignal > lastHandledSignal.current) {
      lastHandledSignal.current = currentSignal;
      if (!isExpanded) {
        if (onToggleExpand) {
          onToggleExpand(task.id);
        } else {
          setInternalIsExpanded(true);
        }
      }
    }
  }, [expansionSignals, task.id, onToggleExpand, isExpanded]);

  const subtasks = allTasks.filter(t => t.parentId === task.id);
  const hasIncompleteSubtasks = subtasks.some(s => s.status !== 'done');
  
  const priorityColors = {
    high: 'bg-rose-500',
    medium: 'bg-amber-500',
    low: 'bg-emerald-500'
  };

  const priorityBorders = {
    high: 'border-rose-100',
    medium: 'border-amber-100',
    low: 'border-emerald-100'
  };

  const handleAttachmentClick = (e: React.MouseEvent, url: string, name: string) => {
    e.stopPropagation();
    if (url.startsWith('data:image') || url.match(/\.(jpeg|jpg|gif|png)$/i) || url.startsWith('blob:')) {
      onImageClick?.(url);
    } else {
      window.open(url, '_blank');
    }
  };

  const isNew = lastCreatedTaskId === task.id;

  return (
    <motion.div 
      layout="position"
      transition={{ 
        layout: { type: "spring", stiffness: 300, damping: 35 },
        opacity: { duration: 0.2 }
      }}
      className={cn(
        "group relative bg-white rounded-xl border border-slate-200 hover:border-indigo-200 hover:shadow-sm cursor-pointer overflow-hidden transition-all",
        disabled && "opacity-40 grayscale pointer-events-none",
        isLocked && "ring-2 ring-indigo-400 border-indigo-300",
        isNew && "ring-2 ring-indigo-400/60"
      )}
      onClick={toggleExpand}
    >
      <div className="flex items-stretch min-h-[56px]">
        <div className={cn("w-1 shrink-0", priorityColors[task.priority])} />

        <div className="flex-1 flex items-center py-3 px-4 gap-3 min-w-0">
          <div className="shrink-0">
            {task.status === 'done' ? (
              <CheckCircle2 size={20} className="text-emerald-500" />
            ) : (
              <div className={cn("w-5 h-5 rounded-full border-2", priorityBorders[task.priority])} />
            )}
          </div>

          <div className="flex-1 min-w-0">
            <h4 className={cn(
              "font-semibold text-slate-900 leading-snug",
              depth === 0 ? "text-base" : "text-sm",
              task.status === 'done' && "line-through text-slate-400"
            )}>{task.title}</h4>
            <div className="flex flex-wrap items-center gap-2 mt-1 text-xs text-slate-500">
               <span className="font-medium text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded">{task.category}</span>
               <span className="flex items-center gap-0.5"><Clock size={9} /> {task.estimatedMinutes}分</span>
               {task.attachments.length > 0 && (
                 <span className="flex items-center gap-0.5 text-indigo-400">
                   <Paperclip size={9} /> {task.attachments.length}
                 </span>
               )}
               {subtasks.length > 0 && (
                 <span className="text-indigo-400 flex items-center gap-1">
                   <Layers size={9} /> {subtasks.filter(s => s.status === 'done').length}/{subtasks.length} 完了
                 </span>
               )}
               {task.status === 'done' && task.updatedAt && (
                 <span className="text-emerald-500 flex items-center gap-1">
                   <CheckCircle2 size={9} /> {format(task.updatedAt, "MM/dd HH:mm")} 完了
                 </span>
               )}
               {task.status === 'done' && task.actualMinutes !== undefined && (
                 <span className="text-emerald-500 flex items-center gap-1">
                   <Clock size={9} /> 実績: {task.actualMinutes}分
                 </span>
               )}
               {task.status === 'doing' && task.fights && task.fights.length > 0 && (
                 <span className="text-rose-500 flex items-center gap-1" title={`${task.fights.length} FIGHTs!`}>
                   <ThumbsUp size={9} /> {task.fights.length}
                 </span>
               )}
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0" onClick={e => e.stopPropagation()}>
            <button 
              onClick={() => onEdit(task)}
              className="w-9 h-9 flex items-center justify-center text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-all"
              title="編集"
            >
              <Settings size={16} />
            </button>
            {!disabled && task.status === 'todo' && (
              <button 
                disabled={hasIncompleteSubtasks}
                onClick={() => onStart(task.id)}
                className="h-9 px-3 flex items-center justify-center gap-1 bg-indigo-600 text-white rounded-lg text-xs font-semibold hover:bg-indigo-700 active:scale-95 transition-all disabled:bg-slate-200 disabled:text-slate-400"
                title="開始"
              >
                <Play size={14} fill="currentColor" />
                開始
              </button>
            )}
          </div>
        </div>
      </div>

      <AnimatePresence>
        {isExpanded && (
          <motion.div 
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden border-t border-slate-50"
          >
            <div className="p-3 pt-2 space-y-3">
              {task.mismatchReason && (
                <div className="bg-orange-50 border border-orange-100 rounded-xl p-3 flex flex-col gap-1">
                  <span className="text-[10px] font-black uppercase tracking-widest text-orange-400">⚠️ 完了時間の誤差理由</span>
                  <p className="text-xs font-bold text-slate-700">{task.mismatchReason}</p>
                </div>
              )}
              {task.description && (
                <div className="bg-slate-50 rounded-xl p-2.5 text-[10px] font-medium text-slate-600 italic">
                  {task.description}
                </div>
              )}

              {task.startPhoto && (
                <div className="relative aspect-video w-full rounded-xl overflow-hidden bg-slate-100 max-w-sm mx-auto">
                   <img 
                     src={task.startPhoto} 
                     className="w-full h-full object-cover cursor-zoom-in hover:scale-105 transition-transform duration-500" 
                     alt="Task photo"
                     onClick={(e) => { e.stopPropagation(); onImageClick?.(task.startPhoto!); }}
                     referrerPolicy="no-referrer"
                   />
                   <div className="absolute top-1.5 left-1.5 px-2 py-0.5 bg-black/40 backdrop-blur-md rounded-full text-[7px] text-white font-black tracking-widest flex items-center gap-1">
                      <Camera size={8} /> 開始時の写真
                   </div>
                </div>
              )}

              {task.attachments.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {task.attachments.map((a, i) => (
                    <button 
                      key={i} 
                      onClick={(e) => handleAttachmentClick(e, a.url, a.name)}
                      className="px-2 py-1 bg-white border border-slate-100 text-slate-600 text-[9px] font-bold rounded-lg flex items-center gap-1 hover:bg-slate-50 transition-all"
                    >
                      <Paperclip size={10} />
                      {a.name}
                    </button>
                  ))}
                </div>
              )}

              {(subtasks.length > 0 || lastCreatedTaskId) && (
                <div className="pt-2 space-y-2">
                  <div className="flex items-center justify-between px-1">
                     <h5 className="text-[10px] font-black uppercase text-indigo-400 tracking-widest">サブタスク</h5>
                     <button 
                      onClick={(e) => { e.stopPropagation(); onAddSubtask(task.id); }}
                      className="text-[9px] font-black text-indigo-600 hover:underline flex items-center gap-1"
                     >
                       <Plus size={10} /> 追加
                     </button>
                  </div>
                  
                  <div className="space-y-1.5 pl-3 border-l-2 border-slate-100">
                    {subtasks.map(st => (
                       <TaskCard 
                          key={st.id}
                          task={st}
                          allTasks={allTasks}
                          disabled={disabled}
                          onAddSubtask={onAddSubtask}
                          onEdit={onEdit}
                          onStart={onStart}
                          onImageClick={onImageClick}
                          depth={depth + 1}
                          expansionSignals={expansionSignals}
                          lastCreatedTaskId={lastCreatedTaskId}
                          onToggleExpand={undefined}
                         />
                    ))}
                  </div>
                </div>
              )}

              {!disabled && subtasks.length === 0 && (
                <button 
                  onClick={(e) => { e.stopPropagation(); onAddSubtask(task.id); }}
                  className="w-full py-2 border-2 border-dashed border-slate-100 rounded-xl text-[10px] font-black text-slate-300 hover:border-indigo-100 hover:text-indigo-400 transition-all flex items-center justify-center gap-2"
                >
                  <Plus size={12} /> サブタスク追加
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

interface TaskFormModalProps {
  onClose: () => void;
  onSubmit: (val: any) => void;
  onDelete?: (id: string) => void;
  initialTask?: Task | null;
  parentId?: string | null;
  availableCategories: string[];
}

function TaskFormModal({ onClose, onSubmit, onDelete, initialTask, parentId, availableCategories }: TaskFormModalProps) {
  const [title, setTitle] = useState(initialTask?.title || '');
  const [description, setDescription] = useState(initialTask?.description || '');
  const [minutes, setMinutes] = useState<number>(initialTask?.estimatedMinutes || 30);
  const [priority, setPriority] = useState<TaskPriority>(initialTask?.priority || 'medium');
  const [category, setCategory] = useState(initialTask?.category || (parentId ? 'サブタスク' : availableCategories[0] || '作業'));
  const [dueDate, setDueDate] = useState<string>(initialTask?.dueDate ? format(initialTask.dueDate, "yyyy-MM-dd'T'HH:mm") : format(new Date(), "yyyy-MM-dd'T'HH:mm"));
  const [attachments, setAttachments] = useState<{name: string, url: string}[]>(initialTask?.attachments || []);
  const [showAlert, setShowAlert] = useState(false);
  const [customCategory, setCustomCategory] = useState('');
  const [showCustomCat, setShowCustomCat] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleMinutesChange = (m: number) => {
    if (m >= 60) setShowAlert(true);
    setMinutes(m);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setAttachments([...attachments, { name: file.name, url: URL.createObjectURL(file) }]);
    }
  };

  const categories = availableCategories;

  const presets = [15, 30, 45, 60];

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-6 bg-slate-900/80 backdrop-blur-md" onClick={onClose}>
      <motion.div 
        initial={{ scale: 0.9, opacity: 0, y: 20 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.9, opacity: 0, y: 20 }}
        onClick={e => e.stopPropagation()}
        className="bg-white w-full max-w-xl rounded-t-[32px] sm:rounded-[48px] shadow-2xl overflow-hidden flex flex-col border border-white/20 max-h-[92dvh] sm:max-h-none"
      >
        <div className="p-5 sm:p-10 space-y-6 sm:space-y-8 overflow-y-auto max-h-[85dvh] sm:max-h-[80vh] scrollbar-hide">
          <div className="flex items-start justify-between gap-3">
            <h2 className="text-xl sm:text-3xl font-black leading-tight">{initialTask ? 'タスクの編集' : parentId ? 'サブタスクの追加' : 'プロジェクト・タスクの追加'}</h2>
            <button onClick={onClose} className="p-3 bg-slate-50 hover:bg-slate-100 rounded-2xl transition-all border border-slate-200"><X size={24} /></button>
          </div>

          <div className="space-y-6">
            <div className="space-y-2">
              <label className="text-xs font-black text-slate-400 uppercase tracking-widest pl-2">タスクタイトル</label>
              <input 
                autoFocus
                type="text" 
                className="w-full text-2xl font-bold bg-slate-50 border border-slate-100 rounded-3xl focus:ring-4 focus:ring-indigo-100 focus:bg-white py-5 px-8 outline-none transition-all"
                placeholder="具体的に何を行いますか？"
                value={title}
                onChange={e => setTitle(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <label className="text-xs font-black text-slate-400 uppercase tracking-widest pl-2">詳細・メモ</label>
              <textarea 
                className="w-full h-32 bg-slate-50 border border-slate-100 rounded-3xl focus:ring-4 focus:ring-indigo-100 focus:bg-white py-5 px-8 outline-none transition-all text-sm font-medium"
                placeholder="補足情報、関連リンク、目的など"
                value={description}
                onChange={e => setDescription(e.target.value)}
              />
            </div>

            <div className="space-y-4">
              <label className="text-xs font-black text-slate-400 uppercase tracking-widest pl-2">カテゴリー</label>
              <div className="flex flex-wrap gap-2">
                 {categories.map(c => (
                   <button 
                    key={c}
                    onClick={() => { setCategory(c); setShowCustomCat(false); }}
                    className={cn(
                      "px-4 py-2 rounded-2xl text-xs font-bold transition-all border",
                      category === c && !showCustomCat ? "bg-indigo-600 text-white border-indigo-600 shadow-lg" : "bg-slate-50 text-slate-500 border-slate-200 hover:border-indigo-300"
                    )}
                   >
                     {c}
                   </button>
                 ))}
                 <button 
                  onClick={() => setShowCustomCat(true)}
                  className={cn(
                    "px-4 py-2 rounded-2xl text-xs font-bold transition-all border",
                    showCustomCat ? "bg-indigo-600 text-white border-indigo-600" : "bg-slate-50 text-slate-500 border-slate-200 hover:border-indigo-300"
                  )}
                 >
                   + カスタム
                 </button>
              </div>
              {showCustomCat && (
                <input 
                  type="text"
                  placeholder="カテゴリー名を入力..."
                  className="w-full bg-slate-50 border border-slate-100 rounded-2xl py-3 px-6 text-sm font-bold outline-none"
                  value={customCategory}
                  onChange={e => { setCustomCategory(e.target.value); setCategory(e.target.value); }}
                />
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-2">
                <label className="text-xs font-black text-slate-400 uppercase tracking-widest pl-2">見積もり時間（分）</label>
                <div className="flex gap-2 mb-2">
                  {presets.map(p => (
                    <button 
                      key={p}
                      onClick={() => setMinutes(p)}
                      className={cn(
                        "flex-1 py-2 text-xs font-black rounded-xl transition-all border",
                        minutes === p ? "bg-indigo-600 text-white border-indigo-600" : "bg-white text-slate-400 border-slate-200 hover:bg-slate-50"
                      )}
                    >
                      {p}分
                    </button>
                  ))}
                </div>
                <input 
                  type="number" 
                  className="w-full bg-slate-50 border border-slate-100 rounded-3xl focus:ring-4 focus:ring-indigo-100 focus:bg-white py-4 px-8 text-xl font-bold outline-none transition-all"
                  value={minutes}
                  onChange={e => handleMinutesChange(parseInt(e.target.value) || 0)}
                />
              </div>
              <div className="space-y-2">
                <label className="text-xs font-black text-slate-400 uppercase tracking-widest pl-2">期限日時</label>
                <input 
                  type="datetime-local" 
                  className="w-full bg-slate-50 border border-slate-100 rounded-3xl focus:ring-4 focus:ring-indigo-100 focus:bg-white py-4 px-8 text-sm font-bold outline-none transition-all"
                  value={dueDate}
                  onChange={e => setDueDate(e.target.value)}
                />
              </div>
            </div>

            {showAlert && (
              <motion.div 
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                className="p-5 bg-indigo-50 border border-indigo-100 rounded-[32px] flex gap-4"
              >
                <Sparkles className="text-indigo-500 shrink-0 mt-1" size={24} />
                <div className="text-sm text-indigo-900 font-bold leading-relaxed">
                  1時間以上のタスクです。AIは「サブタスクに分解」して順次ロックすることを推奨しています。
                  <button className="block mt-2 text-indigo-600 underline" onClick={() => setShowAlert(false)}>ヒントを閉じる</button>
                </div>
              </motion.div>
            )}

            <div className="space-y-2">
              <label className="text-xs font-black text-slate-400 uppercase tracking-widest pl-2 block">優先度</label>
              <div className="flex p-2 bg-slate-100 rounded-[32px] gap-2">
                {(['low', 'medium', 'high'] as TaskPriority[]).map(p => (
                  <button 
                    key={p}
                    onClick={() => setPriority(p)}
                    className={cn(
                      "flex-1 py-3 text-sm font-black rounded-2xl transition-all capitalize border-2 border-transparent",
                      priority === p 
                        ? (p === 'high' ? "bg-rose-500 text-white shadow-lg" : p === 'medium' ? "bg-amber-500 text-white shadow-lg" : "bg-emerald-500 text-white shadow-lg") 
                        : "text-slate-400 hover:bg-white/50"
                    )}
                  >
                    {p === 'high' ? '🔥高' : p === 'medium' ? '⚡中' : '💧低'}
                  </button>
                ))}
              </div>
            </div>
            
            <div className="pt-2">
               <input 
                  type="file" 
                  ref={fileInputRef} 
                  className="hidden" 
                  onChange={handleFileUpload}
               />
               <button onClick={() => fileInputRef.current?.click()} className="flex items-center gap-3 bg-slate-50 hover:bg-slate-100 px-6 py-4 rounded-3xl border border-slate-100 text-slate-600 text-sm font-bold transition-all w-full">
                 <Paperclip size={20} className="text-indigo-500" />
                 ファイルを添付する (資料、スクショなど)
                 {attachments.length > 0 && <span className="ml-auto bg-indigo-600 text-white text-[10px] px-2 py-0.5 rounded-full">{attachments.length}</span>}
               </button>
               <div className="mt-4 flex flex-wrap gap-2">
                  {attachments.map((a, i) => (
                    <span key={i} className="px-3 py-1 bg-indigo-50 text-indigo-600 text-[10px] font-bold rounded-lg border border-indigo-100 flex items-center gap-2">
                      {a.name}
                      <X size={12} className="cursor-pointer" onClick={() => setAttachments(prev => prev.filter((_, idx) => idx !== i))} />
                    </span>
                  ))}
               </div>
            </div>
          </div>
        </div>

        <div className="p-10 bg-slate-50 border-t border-slate-100 flex gap-4">
           {initialTask && onDelete && (
             <button 
               onClick={(e) => { e.preventDefault(); onDelete(initialTask.id); }}
               className="px-8 bg-rose-50 text-rose-600 rounded-[32px] font-black hover:bg-rose-100 transition-all flex items-center justify-center gap-2 border border-rose-100 shadow-xl shadow-rose-100/20 active:scale-90"
               title="タスクを削除"
             >
               <X size={20} />
               <span className="text-sm">削除</span>
             </button>
           )}
           <button 
             disabled={!title}
             onClick={() => onSubmit({ 
               title, 
               description, 
               estimatedMinutes: minutes, 
               priority, 
               category, 
               attachments, 
               dueDate: new Date(dueDate),
               parentId: parentId || initialTask?.parentId || null
             })}
             className="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white py-6 rounded-[32px] font-black text-xl shadow-2xl shadow-indigo-200 transition-all disabled:bg-slate-300 disabled:shadow-none active:scale-95"
           >
             {initialTask ? '変更を保存する' : parentId ? 'サブタスクを追加' : 'タスクを追加'}
           </button>
        </div>
      </motion.div>
    </div>
  );
}
function MemberDetailModal({ member, tasks, onClose, onImageClick, expansionSignals = {} }: { member: UserProfile, tasks: Task[], onClose: () => void, onImageClick: (url: string) => void, expansionSignals?: Record<string, number> }) {
  const memberTasks = tasks.filter(t => t.userId === member.id);
  const completedTasks = memberTasks.filter(t => t.status === 'done');
  
  const [selectedCategory, setSelectedCategory] = useState<string>('すべて');
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);

  const handleToggleExpand = (id: string) => {
    setExpandedTaskId(prev => prev === id ? null : id);
  };

  const groupedMemberTasks = useMemo(() => {
    const list = memberTasks.filter(t => t.status !== 'done' && !t.parentId);
    const sorted = [...list].sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime());
    
    const groups: Record<string, Task[]> = {};
    sorted.forEach(t => {
      const d = new Date(t.dueDate);
      let label = format(d, 'M/d (E)', { locale: ja });
      if (isToday(d)) label = '今日 - ' + label;
      else if (isTomorrow(d)) label = '明日 - ' + label;
      
      if (!groups[label]) groups[label] = [];
      groups[label].push(t);
    });
    return groups;
  }, [memberTasks]);

  const availableCategories = useMemo(() => {
    const cats = new Set(memberTasks.map(t => t.category));
    return Array.from(cats);
  }, [memberTasks]);

  const totalMinutes = completedTasks.reduce((acc, t) => acc + (t.actualMinutes || 0), 0);
  const focusScore = Math.min(100, Math.floor((totalMinutes / (memberTasks.length * 30 || 1)) * 50 + 50));

  const availableCategoriesForDisplay = availableCategories;

  return (
     <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-6 bg-slate-900/80 backdrop-blur-md" onClick={onClose}>
        <motion.div 
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 20, opacity: 0 }}
          onClick={e => e.stopPropagation()}
          className="bg-slate-50 w-full max-w-6xl h-[95dvh] sm:h-[90vh] rounded-t-[32px] sm:rounded-[48px] shadow-2xl overflow-hidden flex flex-col font-sans relative"
        >
          {/* Close button - Fixed position */}
          <button onClick={onClose} className="absolute top-4 right-4 sm:top-6 sm:right-6 p-3 bg-white/20 backdrop-blur-md text-white rounded-2xl hover:bg-white/30 transition-all z-30 border border-white/20 shadow-xl">
             <X size={24} />
          </button>

          <div className="flex-1 overflow-y-auto scrollbar-hide">
             {/* Profile Header - Scrolls with content */}
             <div className="relative h-48 md:h-64 bg-indigo-600">
                {member.backgroundImageUrl && (
                  <img src={member.backgroundImageUrl} className="w-full h-full object-cover opacity-40" alt="" referrerPolicy="no-referrer" />
                )}
                <div className="absolute inset-0 bg-gradient-to-t from-slate-50 via-transparent to-transparent"></div>
                
                <div className="absolute -bottom-10 md:-bottom-6 left-4 md:left-12 flex items-end gap-4 md:gap-8 max-w-[calc(100%-32px)]">
                   <div className="w-24 h-24 md:w-40 md:h-40 shrink-0 rounded-[32px] md:rounded-[48px] bg-white p-2 md:p-3 shadow-2xl ring-1 ring-slate-100">
                      <div className="w-full h-full rounded-[24px] md:rounded-[40px] overflow-hidden bg-slate-100">
                         <img src={member.avatarUrl || member.backgroundImageUrl} className="w-full h-full object-cover" alt="" referrerPolicy="no-referrer" />
                      </div>
                   </div>
                   <div className="mb-6 md:mb-8 flex-1 min-w-0">
                      <h2 className="text-3xl md:text-5xl font-black text-white drop-shadow-lg truncate">{member.displayName}</h2>
                      <div className="flex items-center gap-3 mt-3">
                         <span className="px-4 py-1.5 bg-indigo-500 text-white text-[10px] font-black rounded-full uppercase tracking-widest shadow-lg shadow-indigo-500/20 text-center">チームメンバー</span>
                         <span className="text-white font-bold opacity-80 text-sm whitespace-nowrap">ID: {member.slackUid}</span>
                      </div>
                   </div>
                </div>
             </div>

             {/* Stats and Tasks Area */}
             <div className="p-4 md:p-8 pt-16 md:pt-16 space-y-12">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 md:gap-6">
                   <div className="p-6 md:p-8 bg-white rounded-[32px] md:rounded-[40px] border border-slate-100 shadow-sm flex flex-col justify-center items-center text-center gap-2">
                      <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest">集中スコア</div>
                      <div className="text-2xl md:text-4xl font-black text-indigo-600">{focusScore}</div>
                      <div className="w-full h-1.5 bg-slate-100 rounded-full overflow-hidden mt-2">
                         <div className="h-full bg-indigo-500" style={{ width: `${focusScore}%` }}></div>
                      </div>
                   </div>
                   <div className="p-8 bg-white rounded-[40px] border border-slate-100 shadow-sm flex flex-col justify-center items-center text-center gap-2">
                      <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest">完了済み</div>
                      <div className="text-4xl font-black text-slate-800">{completedTasks.length}</div>
                      <div className="text-[10px] font-bold text-slate-400">計 {totalMinutes}分</div>
                   </div>
                   <div className="p-8 bg-white rounded-[40px] border border-slate-100 shadow-sm flex flex-col justify-center items-center text-center gap-2">
                      <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest">ストリーク</div>
                      <div className="text-4xl font-black text-rose-500">🔥 {member.currentStreak}</div>
                      <div className="text-[10px] font-bold text-slate-400">継続日数</div>
                   </div>
                   <div className="p-8 bg-white rounded-[40px] border border-slate-100 shadow-sm flex flex-col justify-center items-center text-center gap-2">
                      <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest">応援数</div>
                      <div className="text-4xl font-black text-indigo-600">💪 {member.fightCount}</div>
                      <div className="text-[10px] font-bold text-slate-400">チームからのエール</div>
                   </div>
                </div>

                <div className="space-y-10">
                   <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 px-2">
                      <h3 className="text-2xl font-black text-slate-800 flex items-center gap-3">
                         <LayoutDashboard size={28} className="text-indigo-600" />
                         タスクボード
                      </h3>
                      
                      <div className="flex items-center gap-2 overflow-x-auto max-w-md scrollbar-hide py-1">
                         {['すべて', ...availableCategoriesForDisplay].map(cat => (
                           <button
                             key={cat}
                             onClick={() => setSelectedCategory(cat)}
                             className={cn(
                               "whitespace-nowrap px-5 py-2 rounded-full text-[10px] font-black uppercase transition-all",
                               selectedCategory === cat 
                                 ? "bg-indigo-600 text-white shadow-lg" 
                                 : "bg-white text-slate-500 shadow-sm border border-slate-100 hover:bg-slate-50"
                             )}
                           >
                             {cat}
                           </button>
                         ))}
                      </div>
                   </div>
                   
                   <div className="space-y-10">
                     {(Object.entries(groupedMemberTasks) as [string, Task[]][]).map(([dateLabel, dateTasks]) => (
                       <div key={dateLabel} className="space-y-4">
                         <div className="flex items-center gap-3 px-2 border-b border-slate-200 pb-2">
                           <CalendarIcon size={16} className="text-slate-400" />
                           <h4 className="text-sm font-black uppercase tracking-widest text-slate-800">{dateLabel}</h4>
                         </div>
                         <div className="grid grid-cols-1 gap-4">
                           {dateTasks
                             .filter(t => selectedCategory === 'すべて' || t.category === selectedCategory)
                             .map(task => (
                               <TaskCard 
                                 key={task.id} 
                                 task={task} 
                                 disabled={false} 
                                 onStart={() => {}}
                                 onEdit={() => {}}
                                 onAddSubtask={() => {}}
                                 allTasks={memberTasks}
                                 onImageClick={onImageClick}
                                 expansionSignals={expansionSignals}
                                 isExpanded={expandedTaskId === task.id}
                                 onToggleExpand={handleToggleExpand}
                               />
                             ))}
                         </div>
                       </div>
                     ))}
                     {memberTasks.filter(t => t.status !== 'done' && !t.parentId).length === 0 && (
                       <div className="py-20 text-center bg-white border-4 border-dashed border-slate-100 rounded-[64px] text-slate-300 font-black text-lg">
                          現在実行可能なタスクはありません
                       </div>
                     )}
                   </div>
                </div>

                <div className="space-y-10 pb-20">
                   <h3 className="text-2xl font-black text-slate-800 flex items-center gap-3 px-2">
                      <CheckCircle2 size={28} className="text-emerald-500" />
                      最近の完了タスク
                   </h3>
                   <div className="grid grid-cols-1 gap-4 opacity-70">
                      {completedTasks.slice(0, 6).map(task => (
                         <TaskCard 
                           key={task.id} 
                           task={task} 
                           disabled={false} 
                           onStart={() => {}}
                           onEdit={() => {}}
                           onAddSubtask={() => {}}
                           allTasks={memberTasks}
                           onImageClick={onImageClick}
                           expansionSignals={expansionSignals}
                           isExpanded={expandedTaskId === task.id}
                           onToggleExpand={handleToggleExpand}
                         />
                      ))}
                   </div>
                   {completedTasks.length === 0 && (
                     <div className="py-12 text-center text-slate-300 font-bold text-sm">
                        完了済みのタスクはまだありません
                     </div>
                   )}
                </div>
             </div>
          </div>
        </motion.div>
     </div>
  );
}

interface GapAnalysisModalProps {
  task: Task;
  onClose: () => void;
  onSubmit: (reason: string) => void;
}

function PhotoCaptureModal({ onClose, onConfirm }: { onClose: () => void, onConfirm: (url?: string) => void }) {
  const [step, setStep] = useState<'invite' | 'capturing' | 'preview'>('invite');
  const [photo, setPhoto] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const startCamera = async () => {
    setStep('capturing');
    try {
      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
      }
    } catch (err) {
      console.error("Camera access failed:", err);
      // Fallback
      setTimeout(() => capturePhoto(), 1000); 
    }
  };

  const capturePhoto = () => {
    if (videoRef.current && canvasRef.current) {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      canvas.width = video.videoWidth || 640;
      canvas.height = video.videoHeight || 640;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.scale(-1, 1);
        ctx.drawImage(video, -canvas.width, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/jpeg');
        setPhoto(dataUrl);
        
        // Stop camera
        const stream = video.srcObject as MediaStream;
        stream?.getTracks().forEach(track => track.stop());
        
        setStep('preview');
      }
    } else {
      // Fallback if video refs aren't ready
      const mockPhotos = [
        'https://images.unsplash.com/photo-1497215728101-856f4ea42174?auto=format&fit=crop&q=80&w=2070',
      ];
      setPhoto(mockPhotos[0]);
      setStep('preview');
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-slate-900/90 backdrop-blur-xl" onClick={onClose}>
      <canvas ref={canvasRef} className="hidden" />
      <motion.div 
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        onClick={e => e.stopPropagation()}
        className="bg-white w-full max-w-md rounded-[48px] shadow-2xl overflow-hidden p-10 text-center space-y-8"
      >
        {step === 'invite' && (
          <>
            <div className="w-20 h-20 bg-indigo-100 rounded-full flex items-center justify-center mx-auto text-indigo-600">
               <ThumbsUp size={40} />
            </div>
            <div className="space-y-2">
              <h2 className="text-2xl font-black">タスクを開始します！</h2>
              <p className="text-slate-500 text-sm font-medium">現在の状況をチームに共有しますか？<br/>(BeReal風に作業風景を撮影)</p>
            </div>
            <div className="grid grid-cols-1 gap-3">
               <button onClick={startCamera} className="py-5 bg-indigo-600 text-white rounded-3xl font-black text-lg shadow-xl shadow-indigo-200 transition-all hover:scale-[1.02] active:scale-95">
                 はい、写真を撮る 📸
               </button>
               <button onClick={() => onConfirm()} className="py-4 bg-slate-100 text-slate-600 rounded-3xl font-bold text-sm hover:bg-slate-200 transition-all">
                 撮らずに開始する
               </button>
            </div>
          </>
        )}

        {step === 'capturing' && (
          <div className="space-y-6">
            <h2 className="text-2xl font-black">準備はいいですか？</h2>
            <div className="relative aspect-square bg-slate-900 rounded-[40px] border-8 border-slate-100 overflow-hidden shadow-inner">
               <video ref={videoRef} autoPlay playsInline className="w-full h-full object-cover scale-x-[-1]" />
               <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <div className="w-24 h-24 border-4 border-white/30 rounded-full animate-ping"></div>
               </div>
            </div>
            <button onClick={capturePhoto} className="w-20 h-20 bg-white border-8 border-indigo-600 rounded-full mx-auto shadow-2xl active:scale-90 transition-all"></button>
            <p className="text-xs font-black text-slate-400 uppercase tracking-widest">Tap to Capture</p>
          </div>
        )}

        {step === 'preview' && (
          <>
            <div className="space-y-2">
              <h2 className="text-2xl font-black">これでOKですか？</h2>
              <p className="text-slate-500 text-sm font-medium">この写真がメンバーの進捗画面に表示されます。</p>
            </div>
            <div className="aspect-square rounded-[40px] overflow-hidden border-8 border-slate-100 shadow-2xl relative">
               <img src={photo!} className="w-full h-full object-cover" alt="Captured" />
               <div className="absolute top-4 left-4 bg-black/50 backdrop-blur px-3 py-1.5 rounded-full text-[10px] text-white font-black uppercase tracking-tighter">Preview</div>
            </div>
            <div className="grid grid-cols-2 gap-4">
               <button onClick={startCamera} className="py-4 bg-slate-100 text-slate-500 rounded-3xl font-bold text-sm hover:bg-slate-200">
                 撮り直す
               </button>
               <button onClick={() => onConfirm(photo!)} className="py-4 bg-indigo-600 text-white rounded-3xl font-black text-sm shadow-xl shadow-indigo-200">
                 これで開始！
               </button>
            </div>
          </>
        )}

        <button onClick={onClose} className="text-slate-400 font-bold text-xs hover:text-slate-600 transition-colors">キャンセル</button>
      </motion.div>
    </div>
  );
}

function GapAnalysisModal({ task, onClose, onSubmit }: GapAnalysisModalProps) {
  const [reason, setReason] = useState('');
  const [customReason, setCustomReason] = useState('');
  const diff = Math.abs(task.estimatedMinutes - task.actualMinutes);
  const isPositive = task.actualMinutes < task.estimatedMinutes;

  const reasons = [
    { id: 'focus', label: '集中できた', color: 'bg-green-500' },
    { id: 'distracted', label: '集中できなかった', color: 'bg-rose-500' },
    { id: 'estimation', label: '見積もりが甘かった', color: 'bg-amber-500' },
    { id: 'other', label: 'その他', color: 'bg-slate-500' }
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-slate-900/60 backdrop-blur-md" onClick={onClose}>
      <motion.div 
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.9, opacity: 0 }}
        onClick={e => e.stopPropagation()}
        className="bg-white w-full max-w-lg rounded-[48px] shadow-2xl p-10 space-y-8"
      >
        <div className="text-center space-y-4">
          <div className={cn(
            "w-24 h-24 rounded-[32px] flex items-center justify-center mx-auto mb-4 shadow-xl",
            isPositive ? "bg-green-100 text-green-500" : "bg-rose-100 text-rose-500"
          )}>
            <AlertTriangle size={48} />
          </div>
          <h2 className="text-2xl font-black">見積乖離の振り返り</h2>
          <div className="inline-flex items-center gap-4 px-6 py-2 bg-slate-50 rounded-2xl border border-slate-100 text-xs font-bold text-slate-500">
            <span>見積: {task.estimatedMinutes}分</span>
            <span className="w-px h-3 bg-slate-200"></span>
            <span className={cn("font-black", isPositive ? "text-green-600" : "text-rose-600")}>実績: {task.actualMinutes}分</span>
            <span className="w-px h-3 bg-slate-200"></span>
            <span className="text-slate-800">差異: {diff}分 ({Math.round((diff / (task.estimatedMinutes || 1)) * 100)}%)</span>
          </div>
        </div>

        <div className="space-y-6">
          <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] block text-center">乖離の主な理由を選択してください</label>
          <div className="grid grid-cols-2 gap-4">
             {reasons.map(opt => (
               <button 
                key={opt.id}
                onClick={() => setReason(opt.label)}
                className={cn(
                  "py-4 px-4 rounded-[24px] font-black text-sm transition-all border-2 flex flex-col items-center gap-2",
                  reason === opt.label ? "bg-indigo-600 text-white border-indigo-600 shadow-xl shadow-indigo-100" : "bg-white text-slate-600 border-slate-100 hover:border-indigo-300"
                )}
               >
                 <div className={cn("w-2 h-2 rounded-full", reason === opt.label ? "bg-white" : opt.color)}></div>
                 {opt.label}
               </button>
             ))}
          </div>
          
          <AnimatePresence>
            {reason === 'その他' && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="overflow-hidden"
              >
                <textarea 
                  placeholder="具体的な理由を記入してください..." 
                  className="w-full bg-slate-50 border-2 border-slate-100 rounded-3xl text-sm p-5 focus:ring-4 focus:ring-indigo-100 focus:border-indigo-500 focus:bg-white transition-all outline-none"
                  rows={3}
                  value={customReason}
                  onChange={(e) => setCustomReason(e.target.value)}
                ></textarea>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <button 
          onClick={() => onSubmit(reason === 'その他' ? customReason : reason)}
          disabled={!reason}
          className={cn(
            "w-full py-5 rounded-[24px] font-black shadow-2xl transition-all active:scale-95 flex items-center justify-center gap-3",
            (!reason) ? "bg-slate-100 text-slate-300 cursor-not-allowed" : "bg-indigo-600 text-white shadow-indigo-200"
          )}
        >
          <CheckCircle2 size={24} />
          振り返りを記録して完了
        </button>
      </motion.div>
    </div>
  );
}

interface CalendarViewProps {
  tasks: Task[];
}

function CalendarView({ tasks, onDayClick }: { tasks: Task[], onDayClick: (date: Date) => void }) {
  const [currentDate, setCurrentDate] = useState(new Date());
  const monthStart = startOfMonth(currentDate);
  const monthEnd = endOfMonth(monthStart);
  const daysInMonth = eachDayOfInterval({ start: monthStart, end: monthEnd });

  const prevMonth = () => setCurrentDate(subMonths(currentDate, 1));
  const nextMonth = () => setCurrentDate(addMonths(currentDate, 1));

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-xl sm:text-2xl font-bold text-slate-900">{format(currentDate, 'yyyy年 M月')}</h2>
        <div className="flex gap-2 self-start sm:self-auto">
           <button onClick={prevMonth} className="px-4 py-2 bg-white text-slate-700 rounded-xl hover:bg-slate-50 transition-all border border-slate-200 text-xs font-semibold">先月</button>
           <button onClick={nextMonth} className="px-4 py-2 bg-white text-slate-700 rounded-xl hover:bg-slate-50 transition-all border border-slate-200 text-xs font-semibold">次月</button>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-1 md:gap-4">
        {['日', '月', '火', '水', '木', '金', '土'].map(d => (
          <div key={d} className="text-center text-[8px] sm:text-[10px] font-black text-slate-400 uppercase tracking-widest py-1 sm:py-2">
            {d}
          </div>
        ))}
        {daysInMonth.map((day, idx) => {
          const dayTasks = tasks.filter(t => isSameDay(t.dueDate, day));
          return (
            <div key={idx}>
              <DayCell day={day} dayTasks={dayTasks} onDayClick={onDayClick} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DayCell({ day, dayTasks, onDayClick }: { day: Date, dayTasks: Task[], onDayClick: (d: Date) => void }) {
  const [showMore, setShowMore] = useState(false);

  return (
    <>
      <motion.div 
        whileHover={{ y: -4 }}
        onClick={() => onDayClick(day)}
        className={cn(
          "min-h-[72px] sm:min-h-[96px] md:min-h-[120px] bg-white/80 backdrop-blur rounded-xl sm:rounded-2xl p-1.5 sm:p-3 border transition-all flex flex-col cursor-pointer group relative",
          isSameDay(day, new Date()) ? "border-indigo-500 ring-2 ring-indigo-500/10 shadow-lg" : "border-slate-200 hover:border-indigo-400"
        )}
      >
        <div className={cn(
          "text-sm font-bold mb-2",
          isSameDay(day, new Date()) ? "text-indigo-600" : "text-slate-800"
        )}>
          {format(day, 'd')}
        </div>
        <div className="flex-1 space-y-1">
          {dayTasks.slice(0, 3).map(t => (
            <div key={t.id} className="text-[10px] font-bold truncate bg-slate-100 rounded px-1.5 py-0.5 text-slate-600 border-l-2 border-indigo-400">
              {t.title}
            </div>
          ))}
          {dayTasks.length > 3 && (
            <button 
              onClick={(e) => { e.stopPropagation(); setShowMore(true); }}
              className="text-[8px] font-black text-indigo-400 pl-1 uppercase tracking-widest hover:underline hover:text-indigo-600 transition-colors"
            >
              + 他 {dayTasks.length - 3} 件
            </button>
          )}
          {dayTasks.length === 0 && (
             <div className="flex-1 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                <Plus size={16} className="text-slate-300" />
             </div>
          )}
        </div>
      </motion.div>

      <AnimatePresence>
        {showMore && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-slate-900/60 backdrop-blur-sm" onClick={() => setShowMore(false)}>
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              onClick={e => e.stopPropagation()}
              className="bg-white w-full max-w-md rounded-[32px] shadow-2xl p-8 max-h-[70vh] flex flex-col"
            >
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h3 className="text-xl font-black text-slate-800">{format(day, 'M月d日')}のタスク</h3>
                  <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-1">合計 {dayTasks.length} 件の予定</p>
                </div>
                <button onClick={() => setShowMore(false)} className="p-2 hover:bg-slate-100 rounded-xl transition-all"><X size={20} /></button>
              </div>
              <div className="flex-1 overflow-y-auto space-y-3 pr-2 scrollbar-hide">
                {dayTasks.map(t => (
                  <div key={t.id} className="p-4 bg-slate-50 rounded-2xl border border-slate-100 hover:border-indigo-200 transition-all">
                    <div className="flex items-center justify-between gap-4 mb-2">
                      <span className="text-[10px] font-black uppercase text-indigo-400 tracking-widest">{t.category}</span>
                      <span className={cn("text-[10px] font-bold px-2 py-0.5 rounded uppercase tracking-tighter", t.status === 'done' ? "bg-green-100 text-green-600" : "bg-indigo-100 text-indigo-600")}>
                        {t.status}
                      </span>
                    </div>
                    <div className="text-sm font-bold text-slate-800">{t.title}</div>
                    {t.description && <div className="text-xs text-slate-500 mt-1 line-clamp-2">{t.description}</div>}
                  </div>
                ))}
              </div>
              <button 
                onClick={() => { setShowMore(false); onDayClick(day); }}
                className="mt-6 w-full py-4 bg-indigo-600 text-white rounded-2xl font-black text-sm shadow-xl shadow-indigo-100 hover:bg-indigo-700 transition-all flex items-center justify-center gap-2"
              >
                <Plus size={18} /> 新しいタスクを追加
              </button>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </>
  );
}

function MessagesView({ 
  members, 
  tasks, 
  currentUser, 
  onShareNewTask, 
  onAssignTask,
  globalMessages,
  onSendMessage,
  onDeleteMessage
}: { 
  members: UserProfile[], 
  tasks: Task[], 
  currentUser: UserProfile, 
  onShareNewTask: () => void, 
  onAssignTask: (task: Task, targetUserId: string) => Promise<Task>,
  globalMessages: ChatMessage[],
  onSendMessage: (msg: ChatMessage) => void,
  onDeleteMessage: (id: string) => void
}) {
  const [selectedThread, setSelectedThread] = useState<UserProfile | null>(null);
  const [search, setSearch] = useState('');
  const [msgInput, setMsgInput] = useState('');
  const [showTaskPicker, setShowTaskPicker] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const sortedMembers = useMemo(() => {
    return [...members].filter(m => m.id !== currentUser.id).sort((a,b) => a.displayName.localeCompare(b.displayName));
  }, [members, currentUser]);

  // 新しいメッセージが来たら一番下にスクロール
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [globalMessages, selectedThread]);

  const filteredMembers = sortedMembers.filter(m => m.displayName.toLowerCase().includes(search.toLowerCase()));

  const handleSendMessage = (text?: string, taskId?: string) => {
    if (!selectedThread || (!msgInput.trim() && !text && !taskId)) return;
    const newMsg: ChatMessage = {
      id: Math.random().toString(36).substr(2, 9),
      senderId: currentUser.id,
      receiverId: selectedThread.id,
      text: text || msgInput,
      timestamp: new Date(),
      relatedTaskId: taskId
    };
    onSendMessage(newMsg);
    setMsgInput('');
    setShowTaskPicker(false);
  };

  const getThreadMessages = (memberId: string) => {
    const me = normalizeEmail(currentUser.id);
    const them = normalizeEmail(memberId);
    return globalMessages
      .filter(msg =>
        (normalizeEmail(msg.senderId) === me && normalizeEmail(msg.receiverId) === them) ||
        (normalizeEmail(msg.senderId) === them && normalizeEmail(msg.receiverId) === me)
      )
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  };

  const shareTask = async (task: Task) => {
    if (!selectedThread) return;
    try {
      const assigned = await onAssignTask(task, selectedThread.id);
      handleSendMessage(`タスクを共有しました: ${task.title}`, assigned.id);
    } catch {
      // onAssignTask shows toast on failure
    }
  };

  const showMobileThread = selectedThread !== null;

  return (
    <div className="max-w-5xl mx-auto h-[calc(100svh-8rem)] min-h-[400px] bg-white/95 backdrop-blur rounded-2xl sm:rounded-[40px] shadow-2xl flex flex-col lg:flex-row border border-white/20 overflow-hidden">
       {/* Sidebar */}
       <div className={cn(
         "w-full lg:w-80 border-b lg:border-b-0 lg:border-r border-slate-100 flex flex-col shrink-0 min-h-0",
         showMobileThread ? "hidden lg:flex" : "flex flex-1 lg:flex-none"
       )}>
          <div className="p-6 border-b border-slate-50">
             <h2 className="text-xl font-black mb-4 px-2">メッセージ</h2>
             <div className="relative">
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
                <input 
                  type="text" 
                  placeholder="メンバーを検索..." 
                  className="w-full bg-slate-100 border-none rounded-2xl pl-12 text-sm py-3"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                />
             </div>
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-1 scrollbar-hide">
             {filteredMembers.map(m => (
                <button 
                  key={m.id}
                  onClick={() => setSelectedThread(m)}
                  className={cn(
                    "w-full p-4 rounded-[32px] flex items-center gap-4 transition-all",
                    selectedThread?.id === m.id ? "bg-indigo-600 text-white shadow-xl shadow-indigo-100" : "hover:bg-slate-50 text-slate-800"
                  )}
                >
                   <div className={cn("w-12 h-12 rounded-full flex items-center justify-center font-black text-sm shrink-0 overflow-hidden", selectedThread?.id === m.id ? "bg-white/20 text-white" : "bg-indigo-50 text-indigo-500 border border-indigo-100")}>
                      {(m.avatarUrl || m.backgroundImageUrl) ? (
                        <img src={m.avatarUrl || m.backgroundImageUrl} className="w-full h-full object-cover" alt="" />
                      ) : m.displayName[0]}
                   </div>
                   <div className="text-left min-w-0 flex-1">
                      <div className="text-sm font-black truncate leading-none">{m.displayName}</div>
                      <div className={cn("text-[10px] mt-1.5 truncate font-medium", selectedThread?.id === m.id ? "text-indigo-100" : "text-slate-400")}>
                        {getThreadMessages(m.id).length ? getThreadMessages(m.id).at(-1)?.text : 'メッセージを送る'}
                      </div>
                   </div>
                </button>
             ))}
          </div>
       </div>

       {/* Thread */}
       <div className={cn(
         "flex-1 flex flex-col relative bg-slate-50/20 min-h-0 min-w-0",
         !showMobileThread ? "hidden lg:flex" : "flex"
       )}>
          {selectedThread ? (
             <>
                <div className="p-4 sm:p-6 bg-white/50 backdrop-blur-md border-b border-slate-50 flex items-center justify-between gap-2 shadow-sm">
                   <div className="flex items-center gap-2 sm:gap-4 min-w-0">
                      <button
                        type="button"
                        onClick={() => setSelectedThread(null)}
                        className="lg:hidden p-2 -ml-1 text-slate-500 hover:bg-slate-100 rounded-xl shrink-0"
                        aria-label="メンバー一覧に戻る"
                      >
                        <ChevronRight size={20} className="rotate-180" />
                      </button>
                      <div className="w-12 h-12 rounded-full bg-indigo-500 flex items-center justify-center text-white font-black text-lg shadow-inner overflow-hidden">
                        {(selectedThread.avatarUrl || selectedThread.backgroundImageUrl) ? (
                           <img src={selectedThread.avatarUrl || selectedThread.backgroundImageUrl} className="w-full h-full object-cover" alt="" />
                        ) : selectedThread.displayName[0]}
                      </div>
                      <div>
                         <div className="text-sm font-black">{selectedThread.displayName}</div>
                         <div className="text-[10px] text-green-500 font-black tracking-widest flex items-center gap-1.5 uppercase">
                           <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></span>
                           online
                         </div>
                      </div>
                   </div>
                   <button 
                     onClick={() => setShowTaskPicker(!showTaskPicker)}
                     className="p-2.5 sm:p-3 text-indigo-600 bg-indigo-50 rounded-2xl hover:bg-indigo-100 transition-all border border-indigo-100 flex items-center gap-1.5 sm:gap-2 text-[10px] sm:text-xs font-black shrink-0"
                   >
                     <Plus size={18} />
                     <span className="hidden sm:inline">タスクを送る</span>
                     <span className="sm:hidden">送る</span>
                   </button>
                </div>
                
                <div className="flex-1 p-4 sm:p-8 overflow-y-auto space-y-4 scrollbar-hide min-h-0">
                   {getThreadMessages(selectedThread.id).length === 0 && (
                     <div className="flex justify-start w-full">
                        <div className="max-w-[85%] p-4 bg-slate-50 border border-slate-100 rounded-2xl rounded-tl-sm text-sm text-slate-500">
                          メッセージを送って会話を始めましょう。
                        </div>
                     </div>
                   )}

                   {getThreadMessages(selectedThread.id).map((msg, i) => {
                      const isMine = normalizeEmail(msg.senderId) === normalizeEmail(currentUser.id);
                      const relatedTask = msg.relatedTaskId ? tasks.find(t => t.id === msg.relatedTaskId) : undefined;
                      return (
                      <div key={msg.id || i} className={cn("flex w-full group/msg gap-2 sm:gap-3", isMine ? "justify-end" : "justify-start")}>
                        {!isMine && (
                           <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-500 font-bold text-xs shrink-0 overflow-hidden shadow-inner">
                              {(selectedThread.avatarUrl || selectedThread.backgroundImageUrl) ? (
                                <img src={selectedThread.avatarUrl || selectedThread.backgroundImageUrl} className="w-full h-full object-cover" alt="" />
                              ) : selectedThread.displayName[0]}
                           </div>
                        )}
                        <div className={cn("relative max-w-[85%] min-w-[120px]", isMine ? "order-1" : "order-2")}>
                          {isMine && (
                            <button 
                              onClick={() => onDeleteMessage(msg.id)}
                              className="absolute -left-9 top-1/2 -translate-y-1/2 p-1.5 text-slate-300 hover:text-rose-500 opacity-0 group-hover/msg:opacity-100 transition-all"
                              title="送信を取り消す"
                            >
                              <X size={14} />
                            </button>
                          )}
                          <div className={cn(
                            "px-4 py-3 rounded-2xl flex flex-col gap-2 shadow-sm",
                            isMine
                              ? "bg-indigo-600 text-white rounded-br-sm"
                              : "bg-white border border-slate-200 text-slate-800 rounded-bl-sm"
                          )}>
                            {msg.text && (
                              <div className={cn("text-sm leading-relaxed whitespace-pre-wrap break-words", isMine ? "text-white" : "text-slate-800")}>
                                {msg.text}
                              </div>
                            )}
                            {msg.relatedTaskId && (
                              <div className={cn("p-3 rounded-xl border flex flex-col gap-1", isMine ? "bg-white/15 border-white/25" : "bg-indigo-50 border-indigo-100")}>
                                 <div className={cn("text-[10px] font-semibold uppercase tracking-wide", isMine ? "text-indigo-100" : "text-indigo-600")}>共有タスク</div>
                                 <div className={cn("font-semibold text-sm truncate", isMine ? "text-white" : "text-slate-800")}>
                                   {relatedTask?.title || 'タスク'}
                                 </div>
                                 {relatedTask && (
                                   <div className={cn("text-[10px]", isMine ? "text-indigo-100" : "text-slate-500")}>
                                     {relatedTask.status === 'done' ? '完了' : relatedTask.status === 'doing' ? '実行中' : '未着手'}
                                     {' · '}{relatedTask.estimatedMinutes}分
                                   </div>
                                 )}
                              </div>
                            )}
                            <div className={cn("text-[10px] text-right", isMine ? "text-indigo-200" : "text-slate-400")}>
                              {format(msg.timestamp, 'HH:mm')}
                            </div>
                          </div>
                        </div>
                        {isMine && (
                           <div className="w-8 h-8 rounded-full bg-indigo-500 flex items-center justify-center text-white font-bold text-xs shrink-0 overflow-hidden">
                              {currentUser.avatarUrl ? (
                                <img src={currentUser.avatarUrl} className="w-full h-full object-cover" alt="" />
                              ) : currentUser.displayName[0]}
                           </div>
                        )}
                      </div>
                   );})}
                   <div ref={messagesEndRef} />
                </div>

                <AnimatePresence>
                  {showTaskPicker && (
                    <>
                      <div className="fixed inset-0 z-40" onClick={() => setShowTaskPicker(false)} />
                      <motion.div 
                        initial={{ y: 20, opacity: 0 }}
                        animate={{ y: 0, opacity: 1 }}
                        exit={{ y: 20, opacity: 0 }}
                        className="absolute bottom-20 left-3 right-3 sm:bottom-24 sm:left-6 sm:right-6 p-5 sm:p-8 bg-white/95 backdrop-blur-xl rounded-[28px] sm:rounded-[40px] shadow-2xl border border-slate-100 z-50 max-h-[60%] flex flex-col"
                      >
                       <div className="flex items-center justify-between mb-6">
                          <h3 className="text-sm font-black uppercase tracking-widest text-slate-400">共有するタスクを選択</h3>
                          <div className="flex gap-2">
                             <button 
                               onClick={onShareNewTask}
                               className="px-4 py-2 bg-indigo-600 text-white rounded-xl text-[10px] font-black shadow-lg hover:bg-indigo-700 transition-all"
                             >
                               新規タスク作成
                             </button>
                             <button onClick={() => setShowTaskPicker(false)} className="p-3 hover:bg-slate-50 rounded-2xl transition-all"><X size={20} /></button>
                          </div>
                       </div>
                       <div className="overflow-y-auto space-y-2 scrollbar-hide pr-2">
                          {tasks.filter(t => t.userId === currentUser.id && t.status !== 'done').map(task => (
                             <button 
                               key={task.id}
                               onClick={() => shareTask(task)}
                               className="w-full p-5 bg-slate-50 hover:bg-indigo-50 rounded-[28px] border border-slate-100 hover:border-indigo-200 transition-all text-left flex items-center justify-between gap-6 group"
                             >
                                <div className="min-w-0">
                                   <div className="font-black text-sm text-slate-800 truncate group-hover:text-indigo-700 transition-colors">{task.title}</div>
                                   <div className="text-[10px] font-bold text-slate-400 mt-1 uppercase tracking-tighter">{task.category}</div>
                                </div>
                                <Plus size={20} className="text-slate-300 group-hover:text-indigo-500 shrink-0" />
                             </button>
                          ))}
                          {tasks.filter(t => t.userId === currentUser.id && t.status !== 'done').length === 0 && (
                            <div className="py-12 text-center text-slate-400 font-bold italic">共有できるタスクがありません</div>
                          )}
                       </div>
                    </motion.div>
                  </>
                  )}
                </AnimatePresence>

                <div className="p-4 sm:p-6 bg-white/50 backdrop-blur-md border-t border-slate-50 shrink-0">
                   <form onSubmit={(e) => { e.preventDefault(); handleSendMessage(); }} className="flex gap-2">
                       <input 
                         type="text" 
                         className="flex-1 min-w-0 bg-white/80 border border-slate-100 rounded-2xl px-4 sm:px-6 py-3 sm:py-5 outline-none focus:ring-4 focus:ring-indigo-100 text-sm font-bold transition-all shadow-inner" 
                         placeholder="メッセージを入力..."
                         value={msgInput}
                         onChange={e => setMsgInput(e.target.value)}
                       />
                       <button type="submit" className="bg-indigo-600 text-white px-6 rounded-2xl shadow-xl shadow-indigo-100 hover:bg-indigo-700 active:scale-95 transition-all">
                          <MessageSquare size={24} fill="currentColor" />
                       </button>
                   </form>
                </div>
             </>
          ) : (
             <div className="flex-1 flex flex-col items-center justify-center p-16 text-center space-y-6">
                <div className="w-24 h-24 bg-white/50 shadow-inner rounded-[48px] flex items-center justify-center text-slate-200 border border-white/20">
                   <MessageSquare size={48} />
                </div>
                <div>
                   <h3 className="font-black text-slate-800 text-2xl tracking-tight">チャットを開始</h3>
                   <p className="text-sm text-slate-400 mt-2 max-w-xs font-medium leading-relaxed">メンバーを選択してメッセージの送信やタスクの共有、相談などが可能です。</p>
                </div>
             </div>
          )}
       </div>
    </div>
  );
}

