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
import { collection, query, onSnapshot, doc, getDoc, setDoc, updateDoc, deleteDoc } from 'firebase/firestore';

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
}

type TaskStatus = 'todo' | 'doing' | 'paused_break' | 'paused_urgent' | 'retained' | 'done';
type TaskPriority = 'high' | 'medium' | 'low';
type AppTheme = 'default' | 'ocean' | 'forest' | 'sunset' | 'minimal';

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
  senderId: string;
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
    updatedAt: normalizeFirestoreDate(entry.updatedAt)
  };
}

function deserializeMember(entry: any, id?: string): UserProfile {
  return {
    id: id || entry.id || '',
    displayName: entry.displayName || entry.email?.split('@')[0] || '',
    avatarUrl: entry.avatarUrl || '',
    slackUid: entry.slackUid || entry.email?.split('@')[0] || '',
    backgroundImageUrl: entry.backgroundImageUrl || '',
    currentStreak: entry.currentStreak || 0,
    badges: entry.badges || [],
    fightCount: entry.fightCount || 0
  };
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
    await setDoc(doc(db, TASKS_COLLECTION, task.id), {
      ...task,
      dueDate: task.dueDate,
      updatedAt: task.updatedAt
    });
  } catch (error) {
    console.error('Firestore save task failed:', error);
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
    await updateDoc(doc(db, TASKS_COLLECTION, taskId), {
      ...data
    } as any);
  } catch (error) {
    console.error('Firestore update task failed:', error);
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

async function saveMemberToFirestore(member: UserProfile) {
  if (!db) return;
  try {
    await setDoc(doc(db, MEMBERS_COLLECTION, member.id), {
      ...member
    });
  } catch (error) {
    console.error('Firestore save member failed:', error);
  }
}

function createUserProfile(email: string, avatarUrl?: string, slackUid?: string): UserProfile {
  const displayName = email.split('@')[0];
  return {
    id: email,
    displayName,
    slackUid: slackUid || displayName,
    backgroundImageUrl: avatarUrl || '',
    avatarUrl,
    currentStreak: 0,
    badges: [],
    fightCount: 0
  };
}

// --- Components ---

export default function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
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
    if (!IS_FIRESTORE_CONFIGURED) {
      try {
        const storedUsers = JSON.parse(localStorage.getItem('syncTaskGamifyUsers') || '{}');
        return Object.values(storedUsers).map((u: any) => createUserProfile(u.email, u.avatarUrl));
      } catch (e) {
        return [];
      }
    }
    return [];
  });
  const [userProfile, setUserProfile] = useState<UserProfile>(DEFAULT_USER_PROFILE);
  const [isLocked, setIsLocked] = useState(false);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [theme, setTheme] = useState<AppTheme>('default');
  const [timerSeconds, setTimerSeconds] = useState(2700); // 45 mins
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [showAiModal, setShowAiModal] = useState(false);
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
  const [fightCount, setFightCount] = useState(userProfile.fightCount);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [showNotifications, setShowNotifications] = useState(false);
  const [toasts, setToasts] = useState<{id: string, message: string}[]>([]);

  const showToast = (message: string) => {
    const id = Math.random().toString(36).substring(2);
    setToasts(prev => [...prev, {id, message}]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 4000);
  };
  const [similarSearchQuery, setSimilarSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('すべて');
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [availableCategories, setAvailableCategories] = useState<string[]>(['作業', '調査', '会議', '休憩', 'Design', 'Engineering', 'Marketing']);
  const [lastCreatedTaskId, setLastCreatedTaskId] = useState<string | null>(null);

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

  const currentUserTasks = useMemo(() => {
    return tasks.filter(t => t.userId === userProfile.id);
  }, [tasks, userProfile.id]);

  const allSearchableTasks = useMemo(() => {
    return currentUserTasks;
  }, [currentUserTasks]);

  const memberProgress = useMemo(() => {
    return members.map(member => {
      const activeTask = tasks.find(t => t.userId === member.id && t.status === 'doing');
      const pendingTasks = tasks.filter(t => t.userId === member.id && t.status !== 'done');
      return {
        userId: member.id,
        member,
        taskTitle: activeTask ? activeTask.title : pendingTasks[0]?.title || 'タスクがありません',
        status: activeTask ? 'doing' : pendingTasks.length ? 'waiting' : 'none',
        progress: activeTask ? 60 + Math.min(40, pendingTasks.length * 10) : pendingTasks.length ? 30 : 0,
        startPhoto: activeTask?.startPhoto
      };
    });
  }, [members, tasks]);

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

  const handleToggleExpand = (id: string) => {
    setExpandedTaskId(prev => prev === id ? null : id);
  };

  const handleLogin = async (email?: string, avatarUrl?: string, slackUid?: string) => {
    if (!email) return;
    console.log('Logged in with email:', email);

    if (IS_FIRESTORE_CONFIGURED && db) {
      try {
        const memberRef = doc(db, MEMBERS_COLLECTION, email);
        const memberSnapshot = await getDoc(memberRef);
        if (memberSnapshot.exists()) {
          const existingMember = deserializeMember(memberSnapshot.data(), memberSnapshot.id);
          setUserProfile(existingMember);
          setMembers(prev => {
            if (prev.some(member => member.id === existingMember.id)) return prev;
            return [...prev, existingMember];
          });
          setIsLoggedIn(true);
          return;
        }

        const newProfile = createUserProfile(email, avatarUrl, slackUid);
        setUserProfile(newProfile);
        setMembers(prev => [...prev, newProfile]);
        await saveMemberToFirestore(newProfile);
        setIsLoggedIn(true);
        return;
      } catch (error) {
        console.error('Firestore handleLogin error:', error);
      }
    }

    // Firestoreが使えない場合のローカルフォールバック
    const storedUsers = JSON.parse(localStorage.getItem('syncTaskGamifyUsers') || '{}');
    const saved = storedUsers[email];
    if (saved) {
      const existingMember = createUserProfile(email, saved.avatarUrl);
      setUserProfile(existingMember);
      setMembers(prev => {
        if (prev.some(member => member.id === existingMember.id)) return prev;
        return [...prev, existingMember];
      });
      setIsLoggedIn(true);
      return;
    }

    const newProfile = createUserProfile(email, avatarUrl, slackUid);
    setUserProfile(newProfile);
    setMembers(prev => [...prev, newProfile]);
    setIsLoggedIn(true);
  };
  const handleLogout = () => setIsLoggedIn(false);

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

    let actionStr = '';
    if (type === 'start') actionStr = `開始しました: ${taskTitle}`;
    if (type === 'end') actionStr = `完了しました: ${taskTitle}`;
    if (type === 'paused') actionStr = `停止しました: ${taskTitle}`;
    if (type === 'assigned') actionStr = `${taskTitle}`;
    if (type === 'fight') actionStr = `メンバーにFIGHTを送りました！`;
    
    if (actionStr) {
      showToast(actionStr);
      
      const slackMessage = `🚀 *SyncTask通知*\n*ユーザー:* ${userProfile.displayName}\n*アクション:* ${actionStr}`;
      sendSlackWebhook(slackMessage);

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
    const updatedTask = { ...task, status: 'doing', startPhoto: photoUrl, updatedAt: new Date() };
    setTasks(prev => prev.map(t => t.id === taskId ? updatedTask : t));
    await updateTaskInFirestore(taskId, { status: 'doing', startPhoto: photoUrl, updatedAt: new Date() });
    setActiveTaskId(taskId);
    setIsLocked(true);
    setTimerSeconds(task.estimatedMinutes * 60);
    setShowPhotoModal(false);
    setPendingStartTaskId(null);
    addNotification('start', task.title);
  };

  const [expansionSignals, setExpansionSignals] = useState<Record<string, number>>({});

  const pauseTask = async (taskId: string, status: TaskStatus) => {
    const task = tasks.find(t => t.id === taskId);
    const updatedTask = task ? { ...task, status, updatedAt: new Date() } : undefined;
    setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status } : t));
    if (updatedTask) await updateTaskInFirestore(taskId, { status, updatedAt: new Date() });
    setShowRescueModal(false);
    if (task) addNotification('paused', task.title);
  };

  const resumeTask = async (taskId: string) => {
    const task = tasks.find(t => t.id === taskId);
    setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: 'doing' } : t));
    if (task) await updateTaskInFirestore(taskId, { status: 'doing', updatedAt: new Date() });
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
    setIsLocked(false);
    setActiveTaskId(null);
    setShowGapModal(false);
    if (task) addNotification('end', task.title);
    confetti({
      particleCount: 150,
      spread: 70,
      origin: { y: 0.6 }
    });
  };

  const handleReaction = (userId: string) => {
    setReactionSent(prev => ({ ...prev, [userId]: true }));
    addNotification('fight', '');
    setTimeout(() => {
      setReactionSent(prev => ({ ...prev, [userId]: false }));
    }, 1500);
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
      const newId = Math.random().toString(36).substr(2, 9);
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

  const addAiTask = async () => {
    const newTask: Task = {
      id: Math.random().toString(36).substr(2, 9),
      userId: userProfile.id,
      assignedBy: 'AIアシスタント',
      parentId: null,
      title: 'ユーザーフィードバックの分析',
      description: '最近のフィードバックから緊急性の高い課題を抽出してまとめます。',
      priority: 'medium',
      category: 'AI提案',
      estimatedMinutes: 30,
      actualMinutes: 0,
      status: 'todo',
      mismatchReason: '',
      attachments: [],
      dueDate: new Date(),
      updatedAt: new Date()
    };
    setTasks([newTask, ...tasks]);
    await saveTaskToFirestore(newTask);
    setShowAiModal(false);
  };

  const urgentTasks = useMemo(() => {
    const threeDaysFromNow = new Date();
    threeDaysFromNow.setDate(threeDaysFromNow.getDate() + 3);
    return currentUserTasks.filter(t => 
      t.status !== 'done' && 
      !t.parentId && 
      t.dueDate && 
      t.dueDate <= threeDaysFromNow
    );
  }, [currentUserTasks]);

  const normalTasks = useMemo(() => {
    const threeDaysFromNow = new Date();
    threeDaysFromNow.setDate(threeDaysFromNow.getDate() + 3);
    return currentUserTasks.filter(t => 
      t.status !== 'done' && 
      !t.parentId && 
      (!t.dueDate || t.dueDate > threeDaysFromNow)
    );
  }, [currentUserTasks]);

  const activeTask = currentUserTasks.find(t => t.id === activeTaskId);

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

  if (!isLoggedIn) return <LoginScreen onLogin={handleLogin} />;

  const themeConfigs = {
    default: "bg-slate-900/40",
    ocean: "bg-blue-900/40",
    forest: "bg-emerald-900/40",
    sunset: "bg-rose-900/40",
    minimal: "bg-white/80"
  };

  const themeText = theme === 'minimal' ? 'text-slate-800' : 'text-white';

  return (
    <div 
      className="min-h-screen font-sans text-slate-800 bg-fixed bg-cover bg-center transition-all duration-700"
      style={{ backgroundImage: userProfile.backgroundImageUrl ? `url(${userProfile.backgroundImageUrl})` : 'none' }}
    >
      <div className={cn("min-h-screen flex overflow-hidden", themeConfigs[theme])}>
        
        <Sidebar 
          sidebarOpen={sidebarOpen}
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          userProfile={userProfile}
          onLogout={handleLogout}
          onClose={() => setSidebarOpen(false)}
        />

        {/* Main Content */}
        <main className={cn(
          "flex-1 transition-all duration-300 lg:ml-64 w-full h-screen overflow-y-auto scrollbar-hide",
          !sidebarOpen && "ml-0"
        )}>
          <header className={cn(
            "sticky top-0 z-30 backdrop-blur-md border-b border-slate-200/50 p-4 flex items-center gap-4",
            theme === 'minimal' ? "bg-white/50" : "bg-black/20"
          )}>
            {!sidebarOpen && (
              <div className="flex items-center gap-3">
                <button 
                  onClick={() => setSidebarOpen(true)}
                  className="p-2 bg-white rounded-xl shadow-sm hover:bg-slate-50 transition-all border border-slate-200"
                >
                  <Menu size={20} />
                </button>
                <div 
                  className="w-8 h-8 rounded-full overflow-hidden border border-white/20 cursor-pointer"
                  onClick={() => setActiveTab('settings')}
                >
                  <img src={userProfile.avatarUrl || userProfile.backgroundImageUrl} className="w-full h-full object-cover" alt="" referrerPolicy="no-referrer" />
                </div>
              </div>
            )}
            <h1 className={cn("text-xl font-bold", theme === 'minimal' ? 'text-slate-800' : 'text-white')}>
              {activeTab === 'dashboard' ? 'ダッシュボード' : 
               activeTab === 'members' ? 'メンバー進捗' :
               activeTab === 'calendar' ? 'カレンダー' : 
               activeTab === 'settings' ? '設定' : 'メッセージ'}
            </h1>
            <div className="flex-1 flex justify-end gap-3">
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
                        className="absolute right-0 mt-2 w-80 bg-white rounded-3xl shadow-2xl border border-slate-100 py-4 z-50 overflow-hidden"
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
                className="md:flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-xl font-medium transition-all shadow-md active:scale-95"
              >
                <Plus size={18} />
                <span className="hidden sm:inline">タスク追加</span>
              </button>
            </div>
          </header>

          <div className="p-6 space-y-8 max-w-7xl mx-auto">
            {activeTab === 'dashboard' && (
              <>
                {/* Active Timer Lock Area */}
                {isLocked && activeTask && (
                  <motion.div 
                    initial={{ y: -20, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    className="bg-slate-900 text-white rounded-3xl p-6 shadow-2xl relative overflow-hidden mb-8"
                  >
                    <div className="flex flex-col md:flex-row items-center justify-between gap-6 relative z-10">
                      <div className="flex-1 space-y-2">
                        <div className="flex items-center gap-2 text-indigo-400 text-sm font-bold uppercase tracking-wider">
                          <Clock size={16} />
                          <span>{activeTask.status === 'doing' ? 'シングルタスク・ロック中' : '一時中断中（救済ステータス）'}</span>
                        </div>
                        <h2 className="text-2xl font-bold">{activeTask.title}</h2>
                        <div className="flex items-center gap-4">
                           <div className="flex items-center gap-1 text-slate-400 text-sm">
                             <User size={14} />
                             <span>自分自身のタスクに集中</span>
                           </div>
                           <div className="px-2 py-0.5 bg-indigo-500/20 text-indigo-300 rounded text-xs font-bold uppercase">
                             {activeTask.category}
                           </div>
                        </div>
                      </div>

                      <div className="flex flex-col items-center">
                        <div className="text-5xl font-mono font-black tracking-widest tabular-nums">
                          {Math.floor(timerSeconds / 60)}:{String(timerSeconds % 60).padStart(2, '0')}
                        </div>
                        <div className="flex gap-4 mt-4">
                          {activeTask.status === 'doing' ? (
                            <button 
                              onClick={() => setShowRescueModal(true)}
                              className="bg-white/10 hover:bg-white/20 p-3 rounded-2xl transition-all"
                              title="一時中断（救済ステータス）"
                            >
                              <Pause size={24} />
                            </button>
                          ) : (
                            <button 
                               onClick={() => resumeTask(activeTask.id)}
                               className="bg-indigo-500 hover:bg-indigo-600 p-3 rounded-2xl transition-all border border-indigo-400"
                               title="再開"
                            >
                              <Play size={24} fill="currentColor" />
                            </button>
                          )}
                          <button 
                            onClick={() => completeTask(activeTask.id)}
                            className="bg-green-500 hover:bg-green-600 p-3 rounded-2xl transition-all shadow-lg shadow-green-500/40"
                          >
                            <CheckCircle2 size={24} />
                          </button>
                        </div>
                      </div>
                    </div>

                    <div className="mt-8 h-3 w-full bg-slate-800 rounded-full overflow-hidden">
                      <motion.div 
                        initial={{ width: '100%' }}
                        animate={{ width: `${(timerSeconds / ((activeTask.estimatedMinutes || 60) * 60)) * 100}%` }}
                        className={cn(
                          "h-full transition-colors duration-500",
                          timerSeconds < 300 ? "bg-red-500 shadow-[0_0_15px_rgba(239,68,68,0.5)]" : 
                          timerSeconds < 900 ? "bg-yellow-500" : "bg-green-500"
                        )}
                      />
                    </div>

                    <div className="mt-4 flex justify-between text-xs font-bold text-slate-500 uppercase tracking-widest">
                      <span>集中ステータス有効</span>
                      <button onClick={() => setShowRescueModal(true)} className="hover:text-white transition-colors">中断理由を編集</button>
                    </div>
                  </motion.div>
                )}

                <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                    <div className="lg:col-span-2 space-y-6">
                      <div className="flex items-center justify-between px-2">
                        <div className="flex gap-6">
                           <button 
                            onClick={() => setShowCompleted(false)}
                            className={cn(
                              "text-lg font-black transition-all pb-2 px-1 relative",
                              !showCompleted ? "text-white" : "text-white/40 hover:text-white/60"
                            )}
                           >
                             マイタスク ({currentUserTasks.filter(t => t.status !== 'done' && !t.parentId).length})
                             {!showCompleted && <motion.div layoutId="tab-underline" className="absolute bottom-0 left-0 right-0 h-1 bg-white rounded-full" />}
                           </button>
                           <button 
                            onClick={() => setShowCompleted(true)}
                            className={cn(
                              "text-lg font-black transition-all pb-2 px-1 relative",
                              showCompleted ? "text-white" : "text-white/40 hover:text-white/60"
                            )}
                           >
                             完了済み ({currentUserTasks.filter(t => t.status === 'done').length})
                             {showCompleted && <motion.div layoutId="tab-underline" className="absolute bottom-0 left-0 right-0 h-1 bg-white rounded-full" />}
                           </button>
                        </div>
                        
                        <div className="flex items-center gap-2 overflow-x-auto max-w-[400px] scrollbar-hide px-2">
                           {['すべて', ...availableCategories].map(cat => (
                             <button
                               key={cat}
                               onClick={() => setSelectedCategory(cat)}
                               className={cn(
                                 "whitespace-nowrap px-4 py-1.5 rounded-full text-[10px] font-black uppercase transition-all",
                                 selectedCategory === cat 
                                   ? "bg-white text-indigo-600 shadow-lg" 
                                   : "bg-white/10 text-white/60 hover:bg-white/20"
                               )}
                             >
                               {cat}
                             </button>
                           ))}
                        </div>

                        <button 
                          onClick={() => setShowAiModal(true)}
                          className="flex items-center gap-1.5 text-indigo-400 bg-white/10 hover:bg-white/20 px-4 py-2 rounded-full text-sm font-bold transition-all border border-white/10"
                        >
                          <Sparkles size={14} />
                          AI提案
                        </button>
                      </div>
                      
                      <div className="space-y-12">
                        <AnimatePresence mode="popLayout">
                          {(Object.entries(groupedTasks) as [string, Task[]][]).map(([dateLabel, dateTasks]) => (
                            <motion.div 
                              key={dateLabel}
                              initial={{ opacity: 0, y: 10 }}
                              animate={{ opacity: 1, y: 0 }}
                              className="space-y-4"
                            >
                              <div className="flex items-center gap-3 px-2 border-b border-white/10 pb-2">
                                <CalendarIcon size={16} className={theme === 'minimal' ? "text-slate-400" : "text-white/40"} />
                                <h4 className={cn("text-sm font-black uppercase tracking-widest", theme === 'minimal' ? "text-slate-600" : "text-white")}>{dateLabel}</h4>
                              </div>
                              <div className="grid grid-cols-1 gap-3">
                                {dateTasks
                                  .filter(t => selectedCategory === 'すべて' || t.category === selectedCategory)
                                  .map(task => (
                                    <TaskCard 
                                      key={task.id} 
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
                                  ))
                                }
                              </div>
                            </motion.div>
                          ))}
                        </AnimatePresence>
                        {currentUserTasks.filter(t => showCompleted ? (t.status === 'done') : (t.status !== 'done' && !t.parentId)).length === 0 && (
                          <div className="py-20 text-center bg-white/5 rounded-[40px] border-2 border-dashed border-white/20">
                            {showCompleted ? (
                              <>
                                <CheckCircle2 className="mx-auto text-white/40 mb-4" size={40} />
                                <p className="text-white font-black">まだ完了したタスクはありません</p>
                              </>
                            ) : (
                              <div className="space-y-4 max-w-sm mx-auto p-4">
                                <div className="w-20 h-20 bg-indigo-500/10 rounded-full flex items-center justify-center mx-auto mb-4 shadow-lg shadow-indigo-500/20">
                                  <Sparkles className="text-indigo-400" size={32} />
                                </div>
                                <h3 className="text-xl font-black text-white">タスクがありません</h3>
                                <p className="text-sm font-medium text-slate-300 leading-relaxed">
                                  右上の「タスク追加」ボタンから、今日やるべきことを書き出してみましょう。チームに見守られながら集中して取り組めます。
                                </p>
                                <button 
                                  onClick={() => setShowTaskForm(true)}
                                  className="mt-4 px-6 py-3 bg-indigo-600 hover:bg-indigo-500 text-white rounded-2xl font-bold transition-all active:scale-95 shadow-xl shadow-indigo-500/30 w-full"
                                >
                                  最初のタスクを作成する
                                </button>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>

                  <div className="space-y-6">
                    <div className="bg-white/80 backdrop-blur shadow-sm rounded-3xl p-6 border border-white/50">
                      <h3 className="text-sm font-bold uppercase text-slate-400 tracking-widest mb-4">継続ステータス</h3>
                      <div className="space-y-3">
                        <div className="flex items-center gap-4 p-4 bg-indigo-50 rounded-2xl border border-indigo-100">
                           <div className="text-2xl">🔥</div>
                           <div>
                             <div className="text-sm font-bold">{userProfile.currentStreak}日連続達成</div>
                             <div className="text-xs text-slate-500">自己ベスト更新まであと3日</div>
                           </div>
                        </div>
                        <div className="flex items-center gap-4 p-4 bg-rose-50 rounded-2xl border border-rose-100">
                           <div className="text-2xl text-rose-500"><ThumbsUp size={20} fill="currentColor" /></div>
                           <div>
                             <div className="text-sm font-bold">{fightCount} Fight 受信</div>
                             <div className="text-xs text-slate-500">チームから応援されています！</div>
                           </div>
                        </div>
                      </div>
                    </div>

                    <div className="bg-white/80 backdrop-blur shadow-sm rounded-3xl p-6 border border-white/50">
                      <h3 className="text-sm font-bold uppercase text-slate-400 tracking-widest mb-4">類似検索</h3>
                      <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
                        <input 
                          type="text" 
                          placeholder="タスク名、タグ、カテゴリ..." 
                          className="w-full bg-slate-100 border-none rounded-xl pl-10 text-sm py-3 focus:ring-2 focus:ring-indigo-500 transition-all"
                          value={similarSearchQuery}
                          onChange={e => setSimilarSearchQuery(e.target.value)}
                        />
                      </div>
                      
                      {similarSearchQuery ? (
                        <div className="mt-4 space-y-2">
                             {allSearchableTasks.filter(t => t.title.toLowerCase().includes(similarSearchQuery.toLowerCase())).length > 0 ? (
                               allSearchableTasks.filter(t => t.title.toLowerCase().includes(similarSearchQuery.toLowerCase())).slice(0, 5).map(st => (
                                 <div key={st.id} className="group p-3 text-xs bg-white rounded-xl border border-slate-100 font-bold text-slate-600 transition-all hover:border-indigo-300">
                                   <div className="flex justify-between items-start gap-2">
                                     <div className="flex flex-col">
                                        <span className="truncate">{st.title}</span>
                                        {st.userId !== userProfile.id && (
                                          <span className="text-[8px] text-indigo-400 font-black">Member: {members.find(m => m.id === st.userId)?.displayName}</span>
                                        )}
                                     </div>
                                     <span className="opacity-50 text-[9px] whitespace-nowrap">{st.category}</span>
                                   </div>
                                   <div className="flex gap-2 mt-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                      <button 
                                        onClick={() => {
                                          if (st.userId === userProfile.id) {
                                            handleEditTask(st);
                                          } else {
                                            setSelectedMemberId(st.userId);
                                            setShowMemberDetail(true);
                                          }
                                        }}
                                        className="text-[9px] text-indigo-500 font-black flex items-center gap-1"
                                      >
                                        <Settings size={10} /> 詳細
                                      </button>
                                      <button 
                                        onClick={() => {
                                          setActiveTab('messages');
                                        }}
                                        className="text-[9px] text-indigo-500 font-black flex items-center gap-1"
                                      >
                                        <MessageSquare size={10} /> 相談
                                      </button>
                                   </div>
                                 </div>
                               ))
                             ) : (
                               <div className="py-4 text-center text-[10px] text-slate-400 font-bold">見つかりませんでした</div>
                             )}
                          </div>
                      ) : (
                        <div className="mt-4">
                           <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">よく検索される言葉</div>
                           <div className="flex flex-wrap gap-2">
                              {['ES', '自己分析', '企業研究'].map(kw => (
                                <button 
                                  key={kw} 
                                  onClick={() => setSimilarSearchQuery(kw)}
                                  className="px-2.5 py-1 bg-white border border-slate-100 rounded-lg text-[10px] font-bold text-slate-500 hover:border-indigo-300 transition-colors"
                                >
                                  {kw}
                                </button>
                              ))}
                           </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </>
            )}

            {activeTab === 'calendar' && (
              <CalendarView 
                tasks={tasks} 
                onDayClick={(date) => {
                  setEditingTask(null);
                  setTargetParentId(null);
                  setShowTaskForm(true);
                  // We should ideally pass this date to the form as default dueDate
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
                   const newId = Math.random().toString(36).substr(2, 9);
                   const newTask: Task = {
                     ...task,
                     id: newId,
                     userId: targetUserId,
                     assignedBy: userProfile.id,
                     status: 'todo',
                     actualMinutes: 0,
                     startPhoto: undefined,
                     mismatchReason: '',
                     updatedAt: new Date()
                   };
                   setTasks(prev => [newTask, ...prev]);
                   await saveTaskToFirestore(newTask);
                   addNotification('assigned', `タスク「${task.title}」をアサインしました`);
                 }}
               />
            )}

            {activeTab === 'members' && (
               <div className="max-w-3xl mx-auto space-y-6">
                  <h2 className="text-2xl font-black mb-6 px-2">チームメンバーの進捗</h2>
                  <div className="space-y-4 px-2">
                    {memberProgress.map((progressItem, idx) => (
                        <div key={idx} className="bg-white p-6 rounded-[32px] shadow-sm border border-slate-100 flex items-center justify-between gap-6 transition-all hover:shadow-md cursor-pointer" onClick={() => { setSelectedMemberId(progressItem.userId); setShowMemberDetail(true); }}>
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
                               <div className="flex items-center gap-3">
                                  <div className="text-sm font-bold text-slate-800 truncate">{progressItem.member.displayName}</div>
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
                               <div className="text-[10px] text-indigo-600 font-bold mt-1 bg-indigo-50 inline-block px-2 py-0.5 rounded uppercase tracking-tighter">
                                  {progressItem.status === 'doing' ? '実行中' : progressItem.status === 'waiting' ? 'タスク待機中' : 'タスクなし'}
                               </div>
                             </div>
                          </div>
                          
                          <div className="flex-1 hidden md:block min-w-0">
                             <div className="text-xs text-slate-500 mb-1 truncate">{progressItem.taskTitle}</div>
                             <div className="h-2 w-full bg-slate-100 rounded-full overflow-hidden">
                                <motion.div 
                                  initial={{ width: 0 }}
                                  animate={{ width: `${progressItem.progress}%` }}
                                  className="h-full bg-indigo-500 shadow-[0_0_8px_rgba(79,70,229,0.3)]"
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
                              "p-3 rounded-2xl transition-all flex flex-col items-center gap-1 min-w-[60px]",
                              reactionSent[progressItem.userId] ? "bg-indigo-600 text-white" : "bg-slate-50 text-slate-600 hover:bg-slate-100 border border-slate-200"
                            )}
                          >
                            <ThumbsUp size={18} className={cn(reactionSent[progressItem.userId] && "animate-bounce")} />
                            <span className="text-[9px] font-black italic">Fight!</span>
                          </motion.button>
                        </div>
                    ))}
                  </div>
               </div>
            )}

            {activeTab === 'settings' && (
              <div className="max-w-2xl mx-auto bg-white rounded-3xl shadow-sm p-8 border border-slate-100 space-y-8">
                 <h2 className="text-2xl font-black">個人設定</h2>
                 <div className="space-y-6">
                    <div className="space-y-3">
                       <label className="text-sm font-bold text-slate-600 block">背景画像のカスタマイズ</label>
                       <div className="flex gap-4">
                          <input 
                            type="text" 
                            placeholder="画像URLを入力..."
                            className="flex-1 bg-slate-100 border-none rounded-xl text-sm px-4 py-3 focus:ring-2 focus:ring-indigo-500"
                            value={userProfile.backgroundImageUrl}
                            onChange={(e) => setUserProfile({...userProfile, backgroundImageUrl: e.target.value})}
                          />
                       </div>
                    </div>

                    {/* User Info Update */}
                    <div className="pt-6 border-t border-slate-100">
                       <label className="text-sm font-bold text-slate-600 block mb-4">プロフィール設定</label>
                       <div className="space-y-6">
                          <div className="flex flex-col gap-2">
                             <span className="text-[10px] font-black uppercase text-slate-400">表示名</span>
                             <input 
                                type="text"
                                value={userProfile.displayName}
                                onChange={(e) => setUserProfile({...userProfile, displayName: e.target.value})}
                                className="bg-slate-50 border-none rounded-xl text-sm px-4 py-3 focus:ring-2 focus:ring-indigo-500"
                             />
                          </div>
                          <div className="flex flex-col gap-4">
                             <div className="flex flex-col gap-2">
                                <span className="text-[10px] font-black uppercase text-slate-400">プロフィールアイコン</span>
                                <div className="flex gap-4 items-center">
                                   <div className="w-20 h-20 rounded-[28px] bg-slate-100 shrink-0 overflow-hidden border border-slate-200">
                                      <img src={userProfile.avatarUrl || userProfile.backgroundImageUrl} className="w-full h-full object-cover" alt="" referrerPolicy="no-referrer" />
                                   </div>
                                   <div className="flex-1 space-y-2">
                                      <button 
                                        onClick={() => document.getElementById('avatar-upload')?.click()}
                                        className="w-full py-2.5 bg-indigo-600 text-white text-xs font-bold rounded-xl hover:bg-indigo-700 transition-all shadow-md"
                                      >
                                        写真を選択
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
                                      <div className="text-[9px] text-slate-400 font-medium">※写真は端末から選択できます</div>
                                   </div>
                                </div>
                             </div>

                             <div className="flex flex-col gap-2">
                                <span className="text-[10px] font-black uppercase text-slate-400">背景画像</span>
                                <div className="space-y-3">
                                   <div className="relative h-32 w-full rounded-3xl overflow-hidden border border-slate-200 bg-slate-100">
                                      <img src={userProfile.backgroundImageUrl} className="w-full h-full object-cover" alt="" referrerPolicy="no-referrer" />
                                      <button 
                                        onClick={() => document.getElementById('bg-upload')?.click()}
                                        className="absolute bottom-3 right-3 p-2 bg-white/80 backdrop-blur text-slate-600 rounded-xl hover:bg-white transition-all shadow-lg"
                                      >
                                        <Camera size={18} />
                                      </button>
                                   </div>
                                   <input 
                                     id="bg-upload"
                                     type="file"
                                     accept="image/*"
                                     className="hidden"
                                     onChange={(e) => {
                                       const file = e.target.files?.[0];
                                       if (file) {
                                         const reader = new FileReader();
                                         reader.onload = (ev) => setUserProfile({...userProfile, backgroundImageUrl: ev.target?.result as string});
                                         reader.readAsDataURL(file);
                                       }
                                     }}
                                   />
                                   <div className="text-[9px] text-slate-400 font-medium text-center">※背景はお好みの写真に変更可能です</div>
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

                    <div className="pt-6 border-t border-slate-100">
                       <label className="text-sm font-bold text-slate-600 block mb-4">テーマ設定</label>
                       <div className="grid grid-cols-5 gap-3">
                          {(['default', 'ocean', 'forest', 'sunset', 'minimal'] as AppTheme[]).map(t => (
                            <button 
                              key={t}
                              onClick={() => setTheme(t)}
                              className={cn(
                                "flex flex-col items-center gap-2 group",
                                theme === t ? "text-indigo-600" : "text-slate-400 hover:text-slate-600"
                              )}
                            >
                              <div className={cn(
                                "w-10 h-10 rounded-full border-4 shadow-sm transition-all",
                                t === 'default' ? "bg-slate-800" : t === 'ocean' ? "bg-blue-600" : t === 'forest' ? "bg-emerald-600" : t === 'sunset' ? "bg-rose-600" : "bg-white",
                                theme === t ? "border-indigo-500" : "border-white group-hover:border-slate-100"
                              )}></div>
                              <span className="text-[9px] font-black uppercase tracking-tighter">{t}</span>
                            </button>
                          ))}
                       </div>
                    </div>

                    <div className="pt-6 border-t border-slate-100">
                       <div className="flex flex-wrap gap-2">
                          {userProfile.badges.map(b => (
                            <span key={b} className="px-3 py-1.5 bg-indigo-50 text-indigo-700 text-xs font-bold rounded-lg border border-indigo-100">
                               ✨ {b}
                            </span>
                          ))}
                       </div>
                    </div>

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
        {showAiModal && <AiProposalModal onClose={() => setShowAiModal(false)} onSubmit={(task) => setTasks([task, ...tasks])} />}
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
      <div className="fixed bottom-6 right-6 z-[300] flex flex-col gap-2 pointer-events-none">
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

function LoginScreen({ onLogin }: { onLogin: (email: string, avatarUrl?: string, slackUid?: string) => void }) {
  const [isRegistering, setIsRegistering] = useState(false);
  const [email, setEmail] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const lastEmail = localStorage.getItem('syncTaskGamifyLastEmail');
    if (lastEmail) {
      setEmail(lastEmail);
    }

    if (typeof window !== 'undefined') {
      const searchParams = new URLSearchParams(window.location.search);
      const slackEmail = searchParams.get('slack_email');
      const slackUid = searchParams.get('slack_uid');
      if (slackEmail) {
        const localUsers = getStoredUsers();
        const avatarFromLocal = localUsers[slackEmail]?.avatarUrl;
        saveLastEmail(slackEmail);
        setEmail(slackEmail);
        onLogin(slackEmail, avatarFromLocal, slackUid || undefined);
        const cleanUrl = window.location.origin + window.location.pathname;
        window.history.replaceState({}, '', cleanUrl);
      }
    }
  }, []);

  const saveLastEmail = (email: string) => {
    localStorage.setItem('syncTaskGamifyLastEmail', email);
  };

  const getStoredUsers = () => {
    return JSON.parse(localStorage.getItem('syncTaskGamifyUsers') || '{}');
  };

  const setStoredUsers = (users: Record<string, { email: string; avatarUrl?: string }>) => {
    localStorage.setItem('syncTaskGamifyUsers', JSON.stringify(users));
  };

  const isFirestoreConfigured = IS_FIRESTORE_CONFIGURED;

  const slackClientId = import.meta.env.VITE_SLACK_CLIENT_ID;
  const slackRedirectUri = import.meta.env.VITE_SLACK_REDIRECT_URI;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!email) {
      setError('メールアドレスを入力してください');
      return;
    }
    if (!email.includes('@')) {
      setError('有効なメールアドレスを入力してください');
      return;
    }

    const localUsers = getStoredUsers();
    let firestoreFailed = false;

    if (isFirestoreConfigured && db) {
      try {
        const memberRef = doc(db, MEMBERS_COLLECTION, email);
        const memberSnapshot = await getDoc(memberRef);

        if (isRegistering) {
          if (memberSnapshot.exists()) {
            setError('このメールアドレスは既に登録されています。ログイン画面からログインしてください。');
            return;
          }
          const newProfile = createUserProfile(email, avatarUrl);
          await setDoc(memberRef, newProfile);
          saveLastEmail(email);
          onLogin(email, avatarUrl);
          return;
        }

        if (!memberSnapshot.exists()) {
          if (localUsers[email]) {
            saveLastEmail(email);
            onLogin(email, localUsers[email].avatarUrl);
            return;
          }
          setError('登録されていないメールアドレスです。初回登録を行ってください。');
          return;
        }

        const savedMember = deserializeMember(memberSnapshot.data(), memberSnapshot.id);
        saveLastEmail(email);
        onLogin(email, savedMember.avatarUrl);
        return;
      } catch (error) {
        console.error('Firestore login error:', error);
        firestoreFailed = true;
      }
    }

    // Firestoreが利用できない場合のローカルフォールバック
    if (isRegistering) {
      if (localUsers[email]) {
        setError('このメールアドレスは既に登録されています。ログイン画面からログインしてください。');
        return;
      }
      localUsers[email] = { email, avatarUrl };
      setStoredUsers(localUsers);
      saveLastEmail(email);
      onLogin(email, avatarUrl);
      return;
    }

    if (localUsers[email]) {
      saveLastEmail(email);
      onLogin(email, localUsers[email].avatarUrl);
      return;
    }

    if (firestoreFailed) {
      setError('Firestoreに接続できませんでした。ローカル登録はまだ行われていません。');
    } else {
      setError('登録されていないメールアドレスです。初回登録を行ってください。');
    }
  };

  const handleSlackLogin = (e: React.MouseEvent) => {
    e.preventDefault();
    if (!slackClientId || !slackRedirectUri) {
      setError('Slack連携はまだ設定されていません。VITE_SLACK_CLIENT_ID と VITE_SLACK_REDIRECT_URI を .env で設定してください。');
      return;
    }

    const slackScope = 'chat:write,users:read,users:read.email';
    const authUrl = `https://slack.com/oauth/v2/authorize?client_id=${encodeURIComponent(slackClientId)}&scope=${encodeURIComponent(slackScope)}&redirect_uri=${encodeURIComponent(slackRedirectUri)}`;
    window.location.href = authUrl;
    return;

    setError('Slack連携はまだ設定されていません。VITE_SLACK_CLIENT_ID と VITE_SLACK_REDIRECT_URI を .env で設定してください。');
  };

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center p-6 relative overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-br from-indigo-900/40 via-purple-900/40 to-slate-950"></div>
      <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-indigo-500/20 blur-[120px] rounded-full"></div>
      <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-purple-500/20 blur-[120px] rounded-full"></div>
      
      <motion.div 
        initial={{ y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        className="w-full max-w-md relative z-10 space-y-8 text-center"
      >
        <div className="space-y-4">
          <div className="inline-flex items-center justify-center p-4 bg-indigo-500/20 rounded-3xl border border-indigo-500/30 mb-2 shadow-lg shadow-indigo-500/20">
            <Sparkles size={48} className="text-indigo-400" />
          </div>
          <h1 className="text-5xl md:text-6xl font-black text-white tracking-tight drop-shadow-md">
            Sync<span className="text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 to-purple-400">Task</span>
          </h1>
          <p className="text-slate-300 font-bold text-lg md:text-xl max-w-sm mx-auto leading-relaxed">互いにプレッシャーをかけて、<br/>意識と生産性を高め合おう。</p>
          
          <div className="flex flex-wrap justify-center gap-2 pt-2 pb-4">
            <span className="px-3 py-1 bg-white/10 border border-white/10 rounded-full text-xs font-bold text-indigo-300 shadow-sm">🔥 FIGHT機能</span>
            <span className="px-3 py-1 bg-white/10 border border-white/10 rounded-full text-xs font-bold text-purple-300 shadow-sm">⏱️ 予実の振り返り</span>
            <span className="px-3 py-1 bg-white/10 border border-white/10 rounded-full text-xs font-bold text-pink-300 shadow-sm">📸 証拠写真の共有</span>
          </div>
        </div>

        <div className="bg-white/5 backdrop-blur-2xl border border-white/10 rounded-[32px] p-8 space-y-6 shadow-2xl">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2 text-left">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest pl-2">メールアドレス</label>
              <input 
                type="email"
                placeholder="example@email.com"
                className="w-full bg-white/5 border border-white/10 rounded-2xl py-4 px-6 text-white outline-none focus:ring-2 focus:ring-indigo-500 transition-all font-medium"
                value={email}
                onChange={e => { setEmail(e.target.value); setError(''); }}
              />
              {error && <p className="text-rose-400 text-[10px] font-bold pl-2">{error}</p>}
            </div>

            {isRegistering && (
              <div className="space-y-2 text-left">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest pl-2">プロフィールアイコン (任意)</label>
                <div className="flex items-center gap-4">
                  <div className="w-16 h-16 rounded-[20px] bg-white/10 border border-white/20 flex items-center justify-center overflow-hidden shrink-0">
                    {avatarUrl ? (
                      <img src={avatarUrl} className="w-full h-full object-cover" alt="Avatar" />
                    ) : (
                      <User className="text-slate-400" size={24} />
                    )}
                  </div>
                  <div className="flex-1">
                    <button 
                      type="button"
                      onClick={() => document.getElementById('login-avatar-upload')?.click()}
                      className="w-full py-3 bg-white/10 text-white text-xs font-bold rounded-xl hover:bg-white/20 transition-all border border-white/10"
                    >
                      画像を選択
                    </button>
                    <input 
                      id="login-avatar-upload"
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) {
                          const reader = new FileReader();
                          reader.onload = (ev) => setAvatarUrl(ev.target?.result as string);
                          reader.readAsDataURL(file);
                        }
                      }}
                    />
                  </div>
                </div>
              </div>
            )}

            <div className="flex flex-col gap-3">
              <button 
                type="submit"
                className="w-full flex items-center justify-center gap-3 bg-indigo-600 text-white py-4 rounded-2xl font-bold hover:bg-indigo-700 transition-all active:scale-95 shadow-xl border border-indigo-500"
              >
                {isRegistering ? '登録してはじめる' : 'メールアドレスでログイン'}
              </button>
              
              {!isRegistering && (
                <button 
                  type="button"
                  onClick={handleSlackLogin}
                  className="w-full flex items-center justify-center gap-3 bg-white text-slate-900 py-4 rounded-2xl font-bold hover:bg-slate-100 transition-all active:scale-95 shadow-xl"
                >
                  <img src="https://cdn.brandfetch.io/slack.com/w/512/h/512/fallback.png" alt="Slack" className="w-5 h-5" />
                  Slackでログイン (通知連携)
                </button>
              )}
            </div>
          </form>

          <div className="p-4 bg-indigo-500/10 rounded-2xl border border-indigo-500/20 text-[10px] text-indigo-300 font-bold leading-relaxed">
             💡 {isRegistering ? '登録したメールアドレス宛に通知が届きます。入力したメールアドレスは次回ログイン時に自動入力されます。' : 'Slackでログインすると、Slack OAuthを使って通知連携が可能です。現在は環境変数が設定されている場合のみSlackの認可画面に遷移します。'}
          </div>
          
          <div className="pt-4 border-t border-white/10">
            <button 
              type="button"
              onClick={() => { setIsRegistering(!isRegistering); setError(''); }}
              className="text-sm font-bold text-white hover:text-indigo-400 transition-colors"
            >
              {isRegistering ? '既にアカウントをお持ちの方はこちら (ログイン)' : '初めての方はこちら (初回登録)'}
            </button>
          </div>
        </div>

        <p className="text-xs text-slate-500 pt-8">続行することで、利用規約およびゲーミフィケーション・ルールに同意したことになります。</p>
      </motion.div>
    </div>
  );
}

interface SidebarItemProps {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  onClick?: () => void;
}

interface SidebarProps {
  sidebarOpen: boolean;
  activeTab: 'dashboard' | 'calendar' | 'messages' | 'members' | 'settings';
  setActiveTab: (tab: 'dashboard' | 'calendar' | 'messages' | 'members' | 'settings') => void;
  userProfile: UserProfile;
  onLogout: () => void;
  onClose: () => void;
}

function Sidebar({ sidebarOpen, activeTab, setActiveTab, userProfile, onLogout, onClose }: SidebarProps) {
  return (
    <aside className={cn(
      "fixed inset-y-0 left-0 z-40 w-64 bg-white/90 backdrop-blur-md border-r border-slate-200 transition-transform duration-300 transform lg:translate-x-0 shadow-2xl lg:shadow-none",
      !sidebarOpen && "-translate-x-full"
    )}>
      <div className="h-full flex flex-col p-4">
        <div className="flex items-center justify-between mb-8 px-2">
          <div className="flex items-center gap-2 text-indigo-600 font-bold text-xl italic cursor-pointer" onClick={() => setActiveTab('dashboard')}>
            <Sparkles size={28} />
            <span>SyncTask</span>
          </div>
          <button onClick={onClose} className="lg:hidden text-slate-400 hover:text-slate-600 border border-slate-200 p-1 rounded-lg">
            <X size={20} />
          </button>
        </div>

        <nav className="flex-1 space-y-2">
          <SidebarItem icon={<LayoutDashboard size={20} />} label="ダッシュボード" active={activeTab === 'dashboard'} onClick={() => setActiveTab('dashboard')} />
          <SidebarItem icon={<User size={20} />} label="メンバー進捗" active={activeTab === 'members'} onClick={() => setActiveTab('members')} />
          <SidebarItem icon={<CalendarIcon size={20} />} label="記録・カレンダー" active={activeTab === 'calendar'} onClick={() => setActiveTab('calendar')} />
          <SidebarItem icon={<MessageSquare size={20} />} label="メッセージ" active={activeTab === 'messages'} onClick={() => setActiveTab('messages')} />
          <SidebarItem icon={<Settings size={20} />} label="設定" active={activeTab === 'settings'} onClick={() => setActiveTab('settings')} />
        </nav>

        <div className="pt-4 border-t border-slate-200">
          <div className="flex items-center gap-3 p-3 bg-slate-50 rounded-2xl border border-slate-100 mb-4 cursor-pointer" onClick={() => setActiveTab('settings')}>
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

function SidebarItem({ icon, label, active, onClick }: SidebarItemProps) {
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
        "group relative bg-white/95 backdrop-blur rounded-2xl border border-slate-200 hover:shadow-md cursor-pointer overflow-hidden",
        disabled && "opacity-40 grayscale pointer-events-none",
        isNew && "ring-ring ring-2 ring-indigo-500/50",
        task.status === 'done' && "opacity-60"
      )}
      onClick={toggleExpand}
    >
      <div className="flex items-stretch min-h-[60px]">
        {/* Priority Strip */}
        <div className={cn("w-1.5 shrink-0", priorityColors[task.priority])} />
        
        {/* Full-height Photo Strip */}
        {task.startPhoto && (
          <div 
            className="w-16 sm:w-20 shrink-0 cursor-zoom-in border-r border-slate-100 relative group overflow-hidden"
            onClick={(e) => {
              e.stopPropagation();
              onImageClick?.(task.startPhoto!);
            }}
            title="タスク開始時の写真"
          >
            <img src={task.startPhoto} className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-300" alt="Start" />
            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors flex items-center justify-center">
              <Search className="text-white opacity-0 group-hover:opacity-100 transition-opacity drop-shadow-md" size={16} />
            </div>
          </div>
        )}

        {/* Main content - Row layout */}
        <div className="flex-1 flex items-center py-2 px-3 gap-3 min-w-0">
          {/* Status/Check - optional visually */}
          <div className="shrink-0">
            {task.status === 'done' ? (
              <CheckCircle2 size={18} className="text-emerald-500" />
            ) : (
              <div className={cn("w-4 h-4 rounded-full border-2", priorityBorders[task.priority])} />
            )}
          </div>

          {/* Title & Info */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 mb-0.5">
               <span className="text-[7px] font-black uppercase text-slate-400 tracking-wider bg-slate-50 px-1 py-0.5 rounded leading-none shrink-0">{task.category}</span>
               <h4 className={cn(
                 "font-bold text-slate-800 leading-tight truncate",
                 depth === 0 ? "text-sm" : "text-xs"
               )}>{task.title}</h4>
            </div>
            
            <div className="flex items-center gap-2 text-[8px] font-bold text-slate-400">
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
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-1 shrink-0 ml-auto" onClick={e => e.stopPropagation()}>
            {!disabled && (
              <button 
                onClick={() => onAddSubtask(task.id)}
                className="w-7 h-7 flex items-center justify-center bg-indigo-50 text-indigo-600 rounded-lg hover:bg-indigo-100 transition-all opacity-0 group-hover:opacity-100"
                title="サブタスク追加"
              >
                <Plus size={14} />
              </button>
            )}
            <button 
              onClick={() => onEdit(task)}
              className="w-7 h-7 flex items-center justify-center text-slate-300 hover:text-slate-600 transition-all"
              title="編集"
            >
              <Settings size={14} />
            </button>
            {!disabled && task.status === 'todo' && (
              <button 
                disabled={hasIncompleteSubtasks}
                onClick={() => onStart(task.id)}
                className="w-8 h-8 flex items-center justify-center bg-indigo-600 text-white rounded-xl shadow-lg hover:scale-105 active:scale-95 transition-all disabled:bg-slate-200 disabled:shadow-none"
                title="開始"
              >
                <Play size={14} fill="currentColor" />
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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-slate-900/80 backdrop-blur-md" onClick={onClose}>
      <motion.div 
        initial={{ scale: 0.9, opacity: 0, y: 20 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.9, opacity: 0, y: 20 }}
        onClick={e => e.stopPropagation()}
        className="bg-white w-full max-w-xl rounded-[48px] shadow-2xl overflow-hidden flex flex-col border border-white/20"
      >
        <div className="p-10 space-y-8 overflow-y-auto max-h-[80vh] scrollbar-hide">
          <div className="flex items-center justify-between">
            <h2 className="text-3xl font-black">{initialTask ? 'タスクの編集' : parentId ? 'サブタスクの追加' : 'プロジェクト・タスクの追加'}</h2>
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
     <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-slate-900/80 backdrop-blur-md" onClick={onClose}>
        <motion.div 
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 20, opacity: 0 }}
          onClick={e => e.stopPropagation()}
          className="bg-slate-50 w-full max-w-6xl h-[90vh] rounded-[48px] shadow-2xl overflow-hidden flex flex-col font-sans relative"
        >
          {/* Close button - Fixed position */}
          <button onClick={onClose} className="absolute top-6 right-6 p-3 bg-white/20 backdrop-blur-md text-white rounded-2xl hover:bg-white/30 transition-all z-30 border border-white/20 shadow-xl">
             <X size={24} />
          </button>

          <div className="flex-1 overflow-y-auto scrollbar-hide">
             {/* Profile Header - Scrolls with content */}
             <div className="relative h-64 bg-indigo-600">
                {member.backgroundImageUrl && (
                  <img src={member.backgroundImageUrl} className="w-full h-full object-cover opacity-40" alt="" referrerPolicy="no-referrer" />
                )}
                <div className="absolute inset-0 bg-gradient-to-t from-slate-50 via-transparent to-transparent"></div>
                
                <div className="absolute -bottom-6 left-12 flex items-end gap-8">
                   <div className="w-40 h-40 rounded-[48px] bg-white p-3 shadow-2xl ring-1 ring-slate-100">
                      <div className="w-full h-full rounded-[40px] overflow-hidden bg-slate-100">
                         <img src={member.avatarUrl || member.backgroundImageUrl} className="w-full h-full object-cover" alt="" referrerPolicy="no-referrer" />
                      </div>
                   </div>
                   <div className="mb-8">
                      <h2 className="text-5xl font-black text-white drop-shadow-lg">{member.displayName}</h2>
                      <div className="flex items-center gap-3 mt-3">
                         <span className="px-4 py-1.5 bg-indigo-500 text-white text-[10px] font-black rounded-full uppercase tracking-widest shadow-lg shadow-indigo-500/20 text-center">チームメンバー</span>
                         <span className="text-white font-bold opacity-80 text-sm whitespace-nowrap">ID: {member.slackUid}</span>
                      </div>
                   </div>
                </div>
             </div>

             {/* Stats and Tasks Area */}
             <div className="px-12 pt-20 space-y-12">
                <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                   <div className="p-8 bg-white rounded-[40px] border border-slate-100 shadow-sm flex flex-col justify-center items-center text-center gap-2">
                      <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest">集中スコア</div>
                      <div className="text-4xl font-black text-indigo-600">{focusScore}</div>
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

interface AiProposalModalProps {
  onClose: () => void;
  onSubmit: (task: Task) => void;
}

function AiProposalModal({ onClose, onSubmit }: AiProposalModalProps) {
  const [messages, setMessages] = useState<{ role: 'ai' | 'user', text: string, options?: Task[] }[]>([
    { role: 'ai', text: 'こんにちは！現在の悩み事や、次に何をすべきか相談に乗ります。何かお手伝いできることはありますか？' }
  ]);
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [userMsgCount, setUserMsgCount] = useState(0);

  const handleSend = () => {
    if (!input.trim()) return;
    const userMsg = { role: 'user' as const, text: input };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setIsTyping(true);
    const newCount = userMsgCount + 1;
    setUserMsgCount(newCount);

    // Simulate AI response
    setTimeout(() => {
      let aiText = "";
      let options: Task[] | undefined = undefined;

      if (newCount < 2) {
        aiText = "なるほど。それについてもう少し詳しく聞かせてください。具体的にどの部分で困っていますか？";
      } else if (newCount === 2) {
        aiText = "ありがとうございます。状況がよくわかりました。あなたの最近の傾向も踏まえると、集中力が高まっている今、以下のタスクを片付けるのが良さそうです。";
        options = [
          {
            id: Math.random().toString(36).substr(2, 9),
            userId: 'user_1',
            assignedBy: 'AIアシスタント',
            parentId: null,
            title: '集中してESの核を作る',
            description: '最も重要な項目にフォーカスしましょう。',
            priority: 'high',
            category: 'AI提案',
            estimatedMinutes: 45,
            actualMinutes: 0,
            status: 'todo',
            mismatchReason: '',
            attachments: [],
            dueDate: new Date(),
            updatedAt: new Date()
          },
          {
            id: Math.random().toString(36).substr(2, 9),
            userId: 'user_1',
            assignedBy: 'AIアシスタント',
            parentId: null,
            title: '関連資料のクイック整理',
            description: '15分で終わる簡単な準備運動です。',
            priority: 'medium',
            category: 'AI提案',
            estimatedMinutes: 15,
            actualMinutes: 0,
            status: 'todo',
            mismatchReason: '',
            attachments: [],
            dueDate: new Date(),
            updatedAt: new Date()
          }
        ];
      } else {
        aiText = "承知しました。さらなる最適化も可能です。まずは提案したタスクを確認してみてください。";
      }

      setMessages(prev => [...prev, { role: 'ai', text: aiText, options }]);
      setIsTyping(false);
    }, 1500);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-slate-900/60 backdrop-blur-md" onClick={onClose}>
      <motion.div 
        initial={{ y: 50, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 50, opacity: 0 }}
        onClick={e => e.stopPropagation()}
        className="bg-white w-full max-w-2xl h-[80vh] rounded-[48px] shadow-2xl flex flex-col overflow-hidden"
      >
        <div className="p-6 border-b border-slate-50 flex items-center justify-between">
           <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-indigo-600 text-white rounded-2xl flex items-center justify-center">
                 <Sparkles size={20} />
              </div>
              <h2 className="font-black">AIタスクコンシェルジュ</h2>
           </div>
           <button onClick={onClose} className="p-2 hover:bg-slate-50 rounded-xl transition-all"><X size={20} /></button>
        </div>

        <div className="flex-1 overflow-y-auto p-8 space-y-6 scrollbar-hide">
           {messages.map((m, i) => (
              <div key={i} className={cn("flex", m.role === 'user' ? "justify-end" : "justify-start")}>
                 <div className={cn(
                    "max-w-[80%] p-5 rounded-3xl",
                    m.role === 'user' ? "bg-indigo-600 text-white rounded-tr-none" : "bg-slate-100 text-slate-800 rounded-tl-none font-medium"
                 )}>
                    <div className="text-sm leading-relaxed">{m.text}</div>
                    {m.options && (
                       <div className="mt-4 space-y-2">
                          {m.options.map(opt => (
                             <button 
                                key={opt.id}
                                onClick={() => {
                                  onSubmit(opt);
                                  onClose();
                                }}
                                className="w-full p-4 bg-white hover:bg-indigo-50 rounded-2xl border border-slate-200 text-left transition-all group"
                             >
                                <div className="text-xs font-black text-indigo-600 mb-1">{opt.priority === 'high' ? 'おすすめ' : 'すぐに完了'}</div>
                                <div className="text-sm font-bold text-slate-800 group-hover:text-indigo-700">{opt.title}</div>
                                <div className="text-[10px] text-slate-400 mt-1">{opt.estimatedMinutes}分 / {opt.category}</div>
                             </button>
                          ))}
                       </div>
                    )}
                 </div>
              </div>
           ))}
           {isTyping && <div className="text-xs text-slate-400 font-bold animate-pulse">AIが思考中...</div>}
        </div>

        <div className="p-6 bg-slate-50 border-t border-slate-100">
           <div className="flex gap-2">
              <input 
                type="text" 
                className="flex-1 bg-white border border-slate-200 rounded-2xl px-6 py-4 outline-none focus:ring-4 focus:ring-indigo-100 text-sm font-medium"
                placeholder="悩み事を入力してください..."
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSend()}
              />
              <button 
                onClick={handleSend}
                className="bg-indigo-600 text-white p-4 rounded-2xl shadow-lg hover:bg-indigo-700 transition-all"
              >
                 <MessageSquare size={20} fill="currentColor" />
              </button>
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
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-black text-white">{format(currentDate, 'yyyy年 M月')}</h2>
        <div className="flex gap-2">
           <button onClick={prevMonth} className="px-4 py-2 bg-white/10 text-white rounded-xl shadow hover:bg-white/20 transition-all border border-white/10 text-xs font-bold">先月</button>
           <button onClick={nextMonth} className="px-4 py-2 bg-white/10 text-white rounded-xl shadow hover:bg-white/20 transition-all border border-white/10 text-xs font-bold">次月</button>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-4">
        {['日', '月', '火', '水', '木', '金', '土'].map(d => (
          <div key={d} className="text-center text-[10px] font-black text-slate-400 uppercase tracking-widest py-2">
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
          "min-h-[120px] bg-white/80 backdrop-blur rounded-2xl p-3 border transition-all flex flex-col cursor-pointer group relative",
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

function MessagesView({ members, tasks, currentUser, onShareNewTask, onAssignTask }: { members: UserProfile[], tasks: Task[], currentUser: UserProfile, onShareNewTask: () => void, onAssignTask: (task: Task, targetUserId: string) => void }) {
  const [selectedThread, setSelectedThread] = useState<UserProfile | null>(null);
  const [search, setSearch] = useState('');
  const [msgInput, setMsgInput] = useState('');
  const [localMessages, setLocalMessages] = useState<Record<string, ChatMessage[]>>({});
  const [showTaskPicker, setShowTaskPicker] = useState(false);
  
  const deleteMessage = (threadId: string, index: number) => {
    setLocalMessages(prev => ({
      ...prev,
      [threadId]: prev[threadId].filter((_, i) => i !== index)
    }));
  };
  
  const sortedMembers = useMemo(() => {
    return [...members].filter(m => m.id !== currentUser.id).sort((a,b) => a.displayName.localeCompare(b.displayName));
  }, [members, currentUser]);

  const filteredMembers = sortedMembers.filter(m => m.displayName.toLowerCase().includes(search.toLowerCase()));

  const handleSendMessage = (text?: string, taskId?: string) => {
    if (!selectedThread || (!msgInput.trim() && !text && !taskId)) return;
    const newMsg: ChatMessage = {
      senderId: currentUser.id,
      text: text || msgInput,
      timestamp: new Date(),
      relatedTaskId: taskId
    };
    setLocalMessages(prev => ({
      ...prev,
      [selectedThread.id]: [...(prev[selectedThread.id] || []), newMsg]
    }));
    setMsgInput('');
    setShowTaskPicker(false);
  };

  const shareTask = (task: Task) => {
    handleSendMessage(`タスクを共有しました: ${task.title}`, task.id);
    if (selectedThread) {
      onAssignTask(task, selectedThread.id);
    }
  };

  const [showNewTaskInChat, setShowNewTaskInChat] = useState(false);

  return (
    <div className="max-w-5xl mx-auto h-[75vh] bg-white/95 backdrop-blur rounded-[40px] shadow-2xl flex border border-white/20 overflow-hidden">
       {/* Sidebar */}
       <div className="w-80 border-r border-slate-100 flex flex-col">
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
                   <div className={cn("w-12 h-12 rounded-full flex items-center justify-center font-black text-sm shrink-0", selectedThread?.id === m.id ? "bg-white/20 text-white" : "bg-indigo-50 text-indigo-500 border border-indigo-100")}>
                      {m.displayName[0]}
                   </div>
                   <div className="text-left min-w-0">
                      <div className="text-sm font-black truncate leading-none">{m.displayName}</div>
                      <div className={cn("text-[10px] mt-1.5 truncate font-medium", selectedThread?.id === m.id ? "text-indigo-100" : "text-slate-400")}>
                        {localMessages[m.id]?.length ? localMessages[m.id].at(-1)?.text : 'メッセージを送る'}
                      </div>
                   </div>
                </button>
             ))}
          </div>
       </div>

       {/* Thread */}
       <div className="flex-1 flex flex-col relative bg-slate-50/20">
          {selectedThread ? (
             <>
                <div className="p-6 bg-white/50 backdrop-blur-md border-b border-slate-50 flex items-center justify-between shadow-sm">
                   <div className="flex items-center gap-4">
                      <div className="w-12 h-12 rounded-full bg-indigo-500 flex items-center justify-center text-white font-black text-lg shadow-inner">{selectedThread.displayName[0]}</div>
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
                     className="p-3 text-indigo-600 bg-indigo-50 rounded-2xl hover:bg-indigo-100 transition-all border border-indigo-100 flex items-center gap-2 text-xs font-black"
                   >
                     <Plus size={18} />
                     タスクを送る
                   </button>
                </div>
                
                <div className="flex-1 p-8 overflow-y-auto space-y-6 scrollbar-hide">
                   <div className="flex justify-start">
                      <div className="max-w-[75%] p-5 bg-white shadow-sm border border-slate-100 rounded-[32px] rounded-tl-none text-sm font-medium text-slate-600 leading-relaxed shadow-indigo-100/10">
                        こんにちは！お疲れ様です。今日の進捗状況はいかがでしょうか？
                      </div>
                   </div>

                   {localMessages[selectedThread.id]?.map((msg, i) => (
                      <div key={i} className={cn("flex group/msg", msg.senderId === currentUser.id ? "justify-end" : "justify-start")}>
                        <div className="relative">
                          {msg.senderId === currentUser.id && (
                            <button 
                              onClick={() => deleteMessage(selectedThread.id, i)}
                              className="absolute -left-10 top-1/2 -translate-y-1/2 p-2 text-slate-300 hover:text-rose-500 opacity-0 group-hover/msg:opacity-100 transition-all"
                              title="送信を取り消す"
                            >
                              <X size={14} />
                            </button>
                          )}
                          <div className={cn(
                            "max-w-[75%] p-5 rounded-[32px] flex flex-col gap-4 shadow-xl",
                            msg.senderId === currentUser.id ? "bg-indigo-600 text-white rounded-tr-none shadow-indigo-200/40" : "bg-white border border-slate-100 text-slate-700 rounded-tl-none shadow-indigo-100/10"
                          )}>
                            <div className="text-sm font-bold leading-relaxed">{msg.text}</div>
                            {msg.relatedTaskId && (
                              <div className={cn("p-4 rounded-2xl border flex flex-col gap-3", msg.senderId === currentUser.id ? "bg-white/10 border-white/20" : "bg-indigo-50 border-indigo-100")}>
                                 <div className="text-[10px] uppercase font-black tracking-widest opacity-60">Shared Task</div>
                                 <div className="font-black truncate text-sm">{tasks.find(t => t.id === msg.relatedTaskId)?.title || '削除されたタスク'}</div>
                                 <button className="w-full py-2.5 bg-indigo-600 text-white rounded-xl text-[10px] font-black hover:bg-indigo-700 transition-all shadow-md">詳細を確認</button>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                   ))}
                </div>

                <AnimatePresence>
                  {showTaskPicker && (
                    <>
                      <div className="fixed inset-0 z-40" onClick={() => setShowTaskPicker(false)} />
                      <motion.div 
                        initial={{ y: 20, opacity: 0 }}
                        animate={{ y: 0, opacity: 1 }}
                        exit={{ y: 20, opacity: 0 }}
                        className="absolute bottom-24 left-6 right-6 p-8 bg-white/95 backdrop-blur-xl rounded-[40px] shadow-2xl border border-slate-100 z-50 max-h-[60%] flex flex-col"
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

                <div className="p-6 bg-white/50 backdrop-blur-md border-t border-slate-50">
                   <form onSubmit={(e) => { e.preventDefault(); handleSendMessage(); }} className="flex gap-2">
                       <input 
                         type="text" 
                         className="flex-1 bg-white/80 border border-slate-100 rounded-2xl px-6 py-5 outline-none focus:ring-4 focus:ring-indigo-100 text-sm font-bold transition-all shadow-inner" 
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

