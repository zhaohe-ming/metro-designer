import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Avatar, Button, ColorPicker, ConfigProvider, Divider, Dropdown, Form, Input, Layout, List, Modal, Popconfirm, Radio, Skeleton, Slider, Space, Tabs, Tooltip, App as AntdApp, message, theme as antdTheme } from 'antd';
import {
  DownOutlined,
  FileAddOutlined,
  FolderOpenOutlined,
  UserOutlined,
  SettingOutlined,
  LogoutOutlined,
  EditOutlined,
  MenuOutlined,
  SaveOutlined,
  ThunderboltOutlined
} from '@ant-design/icons';
import { api, clearToken, getToken, setToken, AIOperation } from './api';
import { createId } from './utils/id';
import AuthPanel from './components/AuthPanel';
import Canvas from './components/Canvas';
import DraggableModal from './components/DraggableModal';
import Sidebar from './components/Sidebar';
import Toolbar from './components/Toolbar';
import VideoExportModal, { VideoExportConfig } from './components/VideoExportModal';
import AIAssistantModal from './components/AIAssistantModal';
import { BaseMapMode, DEFAULT_MAP_SETTINGS, Line, MapSettings, Section, Station, normalizeMapSettings, normalizeSections } from './types';
import { exportVideoFromStage } from './lib/exportVideo';
import { deleteStationFromGraph } from './lib/graphOps';
import { interpretCommand, ResolvedCommand, AppAction } from './lib/commandParser';
import CommandBar from './components/CommandBar';
import { compressImageDataUrl } from './utils/imageCompress';

// 头像 dataURL 体积阈值：超过即认为是"需要压缩的大头像"。
// 后端 PUT /api/me 给的硬上限是 200_000；这里取 60KB 作为"还能再瘦一点"的软阈值。
const AVATAR_COMPRESS_THRESHOLD = 60_000;

const MAX_HISTORY = 50;
const LAST_MAP_KEY = 'metro_last_map_id';
// 全局"上次用过的"标签密度，记忆用户偏好；新建空白方案、加载没有该字段的老方案时用这个兜底
const LABEL_DENSITY_KEY = 'metro_label_density';
const readLabelDensity = (): 'paper' | 'adaptive' | 'key' => {
  try {
    const v = localStorage.getItem(LABEL_DENSITY_KEY);
    if (v === 'paper' || v === 'adaptive' || v === 'key') return v;
  } catch { /* localStorage 不可用就走默认 */ }
  return 'paper';
};
const writeLabelDensity = (value: 'paper' | 'adaptive' | 'key') => {
  try { localStorage.setItem(LABEL_DENSITY_KEY, value); } catch { /* ignore */ }
};
type DocSnapshot = {
  lines: Line[];
  sections: Section[];
  stations: Station[];
  mapSettings: MapSettings;
};
const cloneDoc = (doc: DocSnapshot): DocSnapshot => ({
  lines: doc.lines.map(line => ({ ...line, stationIds: [...line.stationIds], sectionIds: [...line.sectionIds] })),
  sections: doc.sections.map(section => ({
    ...section,
    waypoints: section.waypoints ? section.waypoints.map(point => ({ ...point })) : undefined
  })),
  stations: doc.stations.map(station => ({ ...station })),
  mapSettings: {
    ...doc.mapSettings,
    dotLabelStyle: { ...doc.mapSettings.dotLabelStyle },
    baseMap: {
      ...doc.mapSettings.baseMap,
      amap: doc.mapSettings.baseMap.amap
        ? {
            ...doc.mapSettings.baseMap.amap,
            center: [doc.mapSettings.baseMap.amap.center[0], doc.mapSettings.baseMap.amap.center[1]]
          }
        : undefined
    }
  }
});

const { Header, Sider, Content } = Layout;

type UserProfile = {
  id: string;
  // 老账号迁移期：phone 可能仍有值；新账号 phone 为空。
  phone: string;
  email: string;
  emailVerified: boolean;
  username: string;
  avatar?: string;
  password?: string;
};

type MapSummaryState = {
  id: string;
  name: string;
  updatedAt: string;
  createdAt: string;
  lineCount?: number;
  stationCount?: number;
  sectionCount?: number;
};

type AppLanguage = 'zh-CN' | 'en-US';
type InterfaceTheme = 'light' | 'dark' | 'system';

const LANGUAGE_KEY = 'metro_language';
const INTERFACE_THEME_KEY = 'metro_interface_theme';

const i18n = {
  'zh-CN': {
    saveMap: '保存地图',
    overwriteSave: '覆盖保存',
    viewMaps: '查看地图',
    profile: '个人中心',
    settings: '设置',
    language: '语言',
    simplifiedChinese: '简体中文',
    english: 'English',
    interfaceTheme: '界面主题',
    light: '浅色',
    dark: '深色',
    system: '跟随系统',
    canvasTheme: '画布主题',
    lightCanvas: '浅色画布',
    darkCanvas: '深色画布',
    baseMap: '底图模式',
    plainCanvas: '纯画布',
    amapBaseMap: '高德地图',
    amapStyle: '高德样式',
    amapNormal: '标准',
    amapDark: '深色',
    amapGrey: '灰色',
    amapFresh: '清新',
    mapStyle: '地图样式',
    classicBadge: '经典圆标',
    dotLabel: '专业线网',
    cityStyle: '视觉风格',
    cityStyleStandard: '现代',
    cityStyleBeijing: '经典',
    cityStyleShanghai: '粗体',
    cityStyleMtr: '管道',
    showLineNameLabels: '显示线路名称标注',
    lineNameLabelsOn: '显示',
    lineNameLabelsOff: '隐藏',
    lineCorner: '线路转角',
    lineCornerSharp: '直角',
    lineCornerRound: '圆角',
    lineCornerRadius: '圆角半径',
    dotLabelText: '专业线网站名',
    dotLabelFontSize: '字体大小',
    dotLabelFontWeight: '字体粗细',
    dotLabelColor: '字体颜色',
    resetDefault: '恢复默认',
    unnamedMap: '未命名方案',
    defaultUserName: '地铁设计师',
    signOut: '退出登录',
    close: '关闭',
    phone: '手机号',
    email: '邮箱',
    emailVerified: '已验证',
    emailUnverified: '未验证',
    avatarHint: '点击头像可上传本机图片',
    profileChangeAvatar: '更换头像',
    profileAccountSection: '账号信息',
    profilePasswordSection: '修改密码（可选）',
    profileUsername: '用户名',
    profilePhoneBound: '已绑定',
    profileUsernamePlaceholder: '更新你的用户名',
    profileNewPassword: '新密码',
    profileNewPasswordPlaceholder: '不修改可留空',
    profileConfirmPassword: '确认新密码',
    profileConfirmPasswordPlaceholder: '请再次输入新密码',
    profileCancel: '取消',
    profileSave: '保存修改',
    profilePasswordMin: '密码长度至少 6 位',
    profilePasswordRequiredConfirm: '请再次输入新密码',
    profilePasswordMismatch: '两次输入的密码不一致',
    labelDensity: '站点标签密度',
    labelDensityPaper: '图纸缩放',
    labelDensityAdaptive: '屏幕可读',
    labelDensityKey: '仅关键'
  },
  'en-US': {
    saveMap: 'Save map',
    overwriteSave: 'Overwrite',
    viewMaps: 'Maps',
    profile: 'Profile',
    settings: 'Settings',
    language: 'Language',
    simplifiedChinese: '简体中文',
    english: 'English',
    interfaceTheme: 'Interface theme',
    light: 'Light',
    dark: 'Dark',
    system: 'System',
    canvasTheme: 'Canvas theme',
    lightCanvas: 'Light canvas',
    darkCanvas: 'Dark canvas',
    baseMap: 'Base map',
    plainCanvas: 'Plain canvas',
    amapBaseMap: 'Amap',
    amapStyle: 'Amap style',
    amapNormal: 'Normal',
    amapDark: 'Dark',
    amapGrey: 'Grey',
    amapFresh: 'Fresh',
    mapStyle: 'Map style',
    classicBadge: 'Classic badge',
    dotLabel: 'Transit diagram',
    cityStyle: 'Visual style',
    cityStyleStandard: 'Modern',
    cityStyleBeijing: 'Classic',
    cityStyleShanghai: 'Bold',
    cityStyleMtr: 'Tube',
    showLineNameLabels: 'Line name labels',
    lineNameLabelsOn: 'Show',
    lineNameLabelsOff: 'Hide',
    lineCorner: 'Line corners',
    lineCornerSharp: 'Sharp',
    lineCornerRound: 'Rounded',
    lineCornerRadius: 'Corner radius',
    dotLabelText: 'Transit label text',
    dotLabelFontSize: 'Font size',
    dotLabelFontWeight: 'Font weight',
    dotLabelColor: 'Text color',
    resetDefault: 'Reset default',
    unnamedMap: 'Untitled map',
    defaultUserName: 'Metro Designer',
    signOut: 'Sign out',
    close: 'Close',
    phone: 'Phone',
    email: 'Email',
    emailVerified: 'Verified',
    emailUnverified: 'Unverified',
    avatarHint: 'Click avatar to upload an image',
    profileChangeAvatar: 'Change avatar',
    profileAccountSection: 'Account info',
    profilePasswordSection: 'Change password (optional)',
    profileUsername: 'Username',
    profilePhoneBound: 'Linked',
    profileUsernamePlaceholder: 'Update your username',
    profileNewPassword: 'New password',
    profileNewPasswordPlaceholder: 'Leave blank to keep current',
    profileConfirmPassword: 'Confirm new password',
    profileConfirmPasswordPlaceholder: 'Re-enter the new password',
    profileCancel: 'Cancel',
    profileSave: 'Save changes',
    profilePasswordMin: 'Password must be at least 6 characters',
    profilePasswordRequiredConfirm: 'Please re-enter the new password',
    profilePasswordMismatch: 'Passwords do not match',
    labelDensity: 'Label density',
    labelDensityPaper: 'Scale with view',
    labelDensityAdaptive: 'Screen-readable',
    labelDensityKey: 'Key stations only'
  }
};

const getInitialLanguage = (): AppLanguage =>
  localStorage.getItem(LANGUAGE_KEY) === 'en-US' ? 'en-US' : 'zh-CN';

const getInitialInterfaceTheme = (): InterfaceTheme => {
  const value = localStorage.getItem(INTERFACE_THEME_KEY);
  return value === 'dark' || value === 'system' ? value : 'light';
};

const getSystemTheme = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';

const App: React.FC = () => {
  const [lines, setLines] = useState<Line[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [stations, setStations] = useState<Station[]>([]);
  const [currentLineId, setCurrentLineId] = useState<string | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [profileVisible, setProfileVisible] = useState(false);
  const [saveMapVisible, setSaveMapVisible] = useState(false);
  const [mapsVisible, setMapsVisible] = useState(false);
  const [mapsLoading, setMapsLoading] = useState(false);
  const [saveMapSaving, setSaveMapSaving] = useState(false);
  const [videoModalOpen, setVideoModalOpen] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  // 移动端侧栏抽屉开关。桌面端 CSS 直接展示 Sider，这个 state 只在 ≤768px 起作用。
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
  // AI 助手对话框
  const [aiModalOpen, setAiModalOpen] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [mapName, setMapName] = useState('');
  const [savedMaps, setSavedMaps] = useState<MapSummaryState[]>([]);
  const [currentMap, setCurrentMap] = useState<MapSummaryState | null>(null);
  // "我的地图"列表的搜索 / 行内重命名 / 复制状态
  const [mapsSearchKeyword, setMapsSearchKeyword] = useState('');
  const [renameMapModal, setRenameMapModal] = useState<{ visible: boolean; mapId: string | null; name: string; saving: boolean }>({
    visible: false,
    mapId: null,
    name: '',
    saving: false
  });
  const [duplicatingMapId, setDuplicatingMapId] = useState<string | null>(null);
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [language, setLanguage] = useState<AppLanguage>(getInitialLanguage);
  const [interfaceTheme, setInterfaceTheme] = useState<InterfaceTheme>(getInitialInterfaceTheme);
  const [systemTheme, setSystemTheme] = useState<'light' | 'dark'>(getSystemTheme);
  const [mapSettings, setMapSettings] = useState<MapSettings>(() => ({
    ...DEFAULT_MAP_SETTINGS,
    labelDensity: readLabelDensity()
  }));
  const [past, setPast] = useState<DocSnapshot[]>([]);
  const [future, setFuture] = useState<DocSnapshot[]>([]);
  const isApplyingHistoryRef = useRef(false);
  // 「有未保存修改」标记。任何编辑（pushHistory / undo / redo）置 true；
  // 保存成功、加载 / 新建 / 删除当前方案（resetHistory）置 false。
  // dirtyRef 给 beforeunload 监听器读最新值用，避免重复挂载监听。
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const markDirty = useCallback(() => {
    if (!dirtyRef.current) {
      dirtyRef.current = true;
      setDirty(true);
    }
  }, []);
  const clearDirty = useCallback(() => {
    if (dirtyRef.current) {
      dirtyRef.current = false;
      setDirty(false);
    }
  }, []);

  // 有未保存修改时拦截关闭 / 刷新，触发浏览器原生「离开此页面？」确认，避免误丢工作。
  // 监听只挂一次，读 dirtyRef 取最新值。
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);
  const linesRef = useRef(lines);
  const sectionsRef = useRef(sections);
  const stationsRef = useRef(stations);
  const mapSettingsRef = useRef(mapSettings);
  useEffect(() => { linesRef.current = lines; }, [lines]);
  useEffect(() => { sectionsRef.current = sections; }, [sections]);
  useEffect(() => { stationsRef.current = stations; }, [stations]);
  useEffect(() => { mapSettingsRef.current = mapSettings; }, [mapSettings]);
  // 命令行：当前线路 ref（给命令上下文取最新值）；命令栏输入 ref（/ 聚焦）；视图命令通道
  const currentLineIdRef = useRef<string | null>(null);
  useEffect(() => { currentLineIdRef.current = currentLineId; }, [currentLineId]);
  const commandInputRef = useRef<HTMLInputElement | null>(null);
  const [viewCmd, setViewCmd] = useState<{ seq: number; action: AppAction } | null>(null);

  const pushHistory = useCallback(() => {
    if (isApplyingHistoryRef.current) return;
    const snapshot = cloneDoc({
      lines: linesRef.current,
      sections: sectionsRef.current,
      stations: stationsRef.current,
      mapSettings: mapSettingsRef.current
    });
    setPast(prev => {
      const next = [...prev, snapshot];
      return next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next;
    });
    setFuture([]);
    markDirty();
  }, [markDirty]);

  const resetHistory = useCallback(() => {
    setPast([]);
    setFuture([]);
    clearDirty();
  }, [clearDirty]);

  const handleUndo = useCallback(() => {
    setPast(prevPast => {
      if (prevPast.length === 0) return prevPast;
      const previous = prevPast[prevPast.length - 1];
      const current = cloneDoc({
        lines: linesRef.current,
        sections: sectionsRef.current,
        stations: stationsRef.current,
        mapSettings: mapSettingsRef.current
      });
      isApplyingHistoryRef.current = true;
      setLines(previous.lines);
      setSections(previous.sections);
      setStations(previous.stations);
      setMapSettings(previous.mapSettings);
      setFuture(prevFuture => [current, ...prevFuture].slice(0, MAX_HISTORY));
      Promise.resolve().then(() => { isApplyingHistoryRef.current = false; });
      markDirty();
      return prevPast.slice(0, -1);
    });
  }, [markDirty]);

  // 渐进型设置交互（Slider 拖、ColorPicker 拖）：只在交互开始时压一次历史，
  // 后续 onChange 不再重复压。onChangeComplete 时复位标志。
  const settingsInteractionRef = useRef(false);
  const beginSettingsInteraction = useCallback(() => {
    if (settingsInteractionRef.current) return;
    settingsInteractionRef.current = true;
    pushHistory();
  }, [pushHistory]);
  const endSettingsInteraction = useCallback(() => {
    settingsInteractionRef.current = false;
  }, []);

  const handleRedo = useCallback(() => {
    setFuture(prevFuture => {
      if (prevFuture.length === 0) return prevFuture;
      const upcoming = prevFuture[0];
      const current = cloneDoc({
        lines: linesRef.current,
        sections: sectionsRef.current,
        stations: stationsRef.current,
        mapSettings: mapSettingsRef.current
      });
      isApplyingHistoryRef.current = true;
      setLines(upcoming.lines);
      setSections(upcoming.sections);
      setStations(upcoming.stations);
      setMapSettings(upcoming.mapSettings);
      setPast(prevPast => [...prevPast, current].slice(-MAX_HISTORY));
      Promise.resolve().then(() => { isApplyingHistoryRef.current = false; });
      markDirty();
      return prevFuture.slice(1);
    });
  }, [markDirty]);

  const stageRef = useRef<any>(null);
  const avatarInputRef = useRef<HTMLInputElement | null>(null);
  const text = i18n[language];
  const canUndo = past.length > 0;
  const canRedo = future.length > 0;
  const resolvedInterfaceTheme = interfaceTheme === 'system' ? systemTheme : interfaceTheme;

  const revokeBlobUrl = (url?: string) => {
    if (url && url.startsWith('blob:')) {
      URL.revokeObjectURL(url);
    }
  };

  const normalizeLoadedLines = (loadedLines: any[] = []): Line[] =>
    loadedLines.map((line) => ({
      ...line,
      stationIds: Array.isArray(line.stationIds) ? line.stationIds : [],
      sectionIds: Array.isArray(line.sectionIds) ? line.sectionIds : [],
      lastAddedStationId: typeof line.lastAddedStationId === 'string' ? line.lastAddedStationId : undefined
    }));

  const fileToDataUrl = (file: File) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

  const upsertSavedMap = (summary: MapSummaryState) => {
    setSavedMaps((prev) => {
      // 保存接口返回不一定带 counts，合并已有缓存条目里的 counts，避免计数突然消失
      const existing = prev.find((item) => item.id === summary.id);
      const merged: MapSummaryState = {
        ...existing,
        ...summary,
        lineCount: summary.lineCount ?? existing?.lineCount,
        stationCount: summary.stationCount ?? existing?.stationCount,
        sectionCount: summary.sectionCount ?? existing?.sectionCount
      };
      const rest = prev.filter((item) => item.id !== summary.id);
      return [merged, ...rest].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    });
  };

  const refreshSavedMaps = async (showError = false) => {
    setMapsLoading(true);
    try {
      const { maps } = await api.listMaps();
      setSavedMaps(maps);
    } catch (error: any) {
      if (showError) {
        message.error(error.message || '加载地图列表失败');
      }
    } finally {
      setMapsLoading(false);
    }
  };

  useEffect(() => {
    return () => {
      revokeBlobUrl(userProfile?.avatar);
    };
  }, [userProfile?.avatar]);

  useEffect(() => {
    localStorage.setItem(LANGUAGE_KEY, language);
  }, [language]);

  useEffect(() => {
    localStorage.setItem(INTERFACE_THEME_KEY, interfaceTheme);
  }, [interfaceTheme]);

  useEffect(() => {
    document.body.dataset.interfaceTheme = resolvedInterfaceTheme;
  }, [resolvedInterfaceTheme]);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = () => setSystemTheme(mediaQuery.matches ? 'dark' : 'light');
    handleChange();
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  useEffect(() => {
    const boot = async () => {
      const token = getToken();
      if (!token) return;
      try {
        const { user } = await api.me();
        setUserProfile({ ...user, password: '' });
        refreshSavedMaps(false);
        // 自动恢复上次编辑的方案。任何一步失败就清掉指针并保持空白工作台。
        let lastMapId: string | null = null;
        try { lastMapId = localStorage.getItem(LAST_MAP_KEY); } catch { /* ignore */ }
        if (lastMapId) {
          try {
            const { map } = await api.getMap(lastMapId);
            applyLoadedMap(map);
          } catch {
            try { localStorage.removeItem(LAST_MAP_KEY); } catch { /* ignore */ }
          }
        }
        // 历史存量头像可能是几百 KB 的原图 dataURL，DB 全是这种东西会拖慢列表/me。
        // 静默重压一次后写回；失败就放过。新上传走的是 handleProfileAvatarUpload 里的压缩路径。
        if (
          typeof user.avatar === 'string' &&
          user.avatar.startsWith('data:') &&
          user.avatar.length > AVATAR_COMPRESS_THRESHOLD
        ) {
          try {
            const compressed = await compressImageDataUrl(user.avatar);
            if (compressed.length < user.avatar.length) {
              const { user: migrated } = await api.updateMe({ avatar: compressed });
              setUserProfile({ ...migrated, password: '' });
            }
          } catch (e) {
            console.warn('avatar migration skipped', e);
          }
        }
      } catch {
        clearToken();
      }
    };
    boot();
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return;
      }
      // "/" 聚焦命令栏（不在输入框时）
      if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        commandInputRef.current?.focus();
        return;
      }
      const accel = event.ctrlKey || event.metaKey;
      if (!accel) return;
      const key = event.key.toLowerCase();
      if (key === 'z' && !event.shiftKey) {
        event.preventDefault();
        handleUndo();
      } else if ((key === 'z' && event.shiftKey) || key === 'y') {
        event.preventDefault();
        handleRedo();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleUndo, handleRedo]);

  const handleUpdateSection = (sectionId: string, patch: Partial<Section>) => {
    setSections(prev =>
      prev.map(section => {
        if (section.id !== sectionId) return section;
        const next: Section = { ...section, ...patch };
        if ('waypoints' in patch && (!patch.waypoints || patch.waypoints.length === 0)) {
          delete (next as Partial<Section>).waypoints;
        }
        return next;
      })
    );
  };

  const handleAddLine = (name: string, color: string) => {
    if (lines.some((line) => line.color === color)) {
      message.error('该颜色已被其他线路占用，请选择其他颜色');
      return false;
    }

    pushHistory();
    const newLine: Line = {
      id: createId(),
      name,
      color,
      stationIds: [],
      sectionIds: [],
      lastAddedStationId: undefined
    };

    setLines((prev) => [...prev, newLine]);
    setCurrentLineId(newLine.id);
    return true;
  };

  const handleSelectLine = (id: string) => {
    setCurrentLineId(id);
  };

  const handleDeselectLine = () => {
    setCurrentLineId(null);
  };

  const handleAddStation = (station: Station) => {
    pushHistory();
    setStations((prev) => [...prev, station]);
  };

  const handleUpdateStation = (updatedStation: Station) => {
    // 注意：拖拽期间会触发多次。Canvas 在 onDragStart 时已调 onBeginInteraction 推入一次快照。
    setStations((prev) => prev.map((station) => (station.id === updatedStation.id ? updatedStation : station)));
  };

  const handleRenameStation = (stationId: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) {
      message.warning('站点名称不能为空');
      return;
    }
    pushHistory();
    setStations((prev) => prev.map((station) => (station.id === stationId ? { ...station, name: trimmed } : station)));
    message.success('站点名称已更新');
  };

  const normalizePair = (a: string, b: string) => (a < b ? `${a}_${b}` : `${b}_${a}`);

  const handleAddStationToLine = (
    stationId: string,
    options?: { mode?: 'default' | 'connect' | 'only'; connectToStationId?: string }
  ) => {
    if (!currentLineId) {
      message.warning('请先选择一条线路');
      return;
    }

    const mode = options?.mode || 'default';
    const currentLine = lines.find((line) => line.id === currentLineId);
    if (!currentLine) return;

    pushHistory();

    let nextLine: Line = { ...currentLine };
    let nextSections = [...sections];
    let sectionCreated = false;

    if (!nextLine.stationIds.includes(stationId)) {
      nextLine.stationIds = [...nextLine.stationIds, stationId];
    }

    const addSection = (startId: string, endId: string) => {
      if (!startId || !endId || startId === endId) return;

      const exists = nextLine.sectionIds.some((sectionId) => {
        const currentSection = nextSections.find((section) => section.id === sectionId);
        if (!currentSection) return false;
        return normalizePair(currentSection.startStationId, currentSection.endStationId) === normalizePair(startId, endId);
      });

      if (exists) return;

      const newSection: Section = {
        id: createId(),
        lineId: nextLine.id,
        startStationId: startId,
        endStationId: endId
      };

      nextSections = [...nextSections, newSection];
      nextLine.sectionIds = [...nextLine.sectionIds, newSection.id];
      sectionCreated = true;
    };

    if (mode === 'connect') {
      const targetId = options?.connectToStationId;
      if (!targetId) {
        message.warning('请选择连接目标站点');
        return;
      }
      if (targetId === stationId) {
        message.warning('不能与自身连接');
        return;
      }
      if (!nextLine.stationIds.includes(targetId)) {
        nextLine.stationIds = [...nextLine.stationIds, targetId];
      }
      addSection(targetId, stationId);
    } else if (mode === 'default' && nextLine.lastAddedStationId && nextLine.lastAddedStationId !== stationId) {
      addSection(nextLine.lastAddedStationId, stationId);
    }

    if (mode !== 'only') {
      nextLine.lastAddedStationId = stationId;
    }

    setLines((prev) => prev.map((line) => (line.id === currentLineId ? nextLine : line)));
    setSections(nextSections);

    if (mode === 'only') {
      message.success('站点已加入当前线路');
    } else if (sectionCreated) {
      message.success('已建立区间连接');
    } else {
      message.success('站点已加入当前线路');
    }
  };

  const handleRemoveStationFromLine = (lineId: string, stationId: string) => {
    pushHistory();
    setLines((prev) =>
      prev.map((line) => {
        if (line.id !== lineId) return line;

        const validSectionIds = line.sectionIds.filter((sectionId) => {
          const currentSection = sections.find((section) => section.id === sectionId);
          if (!currentSection) return false;
          return currentSection.startStationId !== stationId && currentSection.endStationId !== stationId;
        });

        return {
          ...line,
          stationIds: line.stationIds.filter((id) => id !== stationId),
          sectionIds: validSectionIds,
          lastAddedStationId: line.lastAddedStationId === stationId ? undefined : line.lastAddedStationId
        };
      })
    );

    setSections((prev) =>
      prev.filter((section) => !(section.lineId === lineId && (section.startStationId === stationId || section.endStationId === stationId)))
    );
  };

  const handleReorderStations = (lineId: string, stationIds: string[]) => {
    pushHistory();
    setLines((prev) =>
      prev.map((line) => {
        if (line.id !== lineId) return line;
        return { ...line, stationIds };
      })
    );
  };

  const handleDeleteLine = (lineId: string) => {
    pushHistory();
    const deletingLine = lines.find((line) => line.id === lineId);
    if (deletingLine) {
      setSections((prev) => prev.filter((section) => !deletingLine.sectionIds.includes(section.id)));
    }

    setLines((prev) => prev.filter((line) => line.id !== lineId));
    if (currentLineId === lineId) {
      setCurrentLineId(null);
    }
    message.success('线路已删除');
  };

  const handleChangeLineColor = (lineId: string, newColor: string) => {
    if (lines.some((line) => line.id !== lineId && line.color === newColor)) {
      message.error('该颜色已被其他线路占用，请选择其他颜色');
      return false;
    }

    pushHistory();
    setLines((prev) => prev.map((line) => (line.id === lineId ? { ...line, color: newColor } : line)));
    message.success('线路颜色已更新');
    return true;
  };

  const handleChangeLineName = (lineId: string, newName: string) => {
    pushHistory();
    setLines((prev) => prev.map((line) => (line.id === lineId ? { ...line, name: newName } : line)));
    message.success('线路名称已更新');
  };

  const handleDeleteStation = (stationId: string) => {
    pushHistory();
    // 删中间站时会自动用一条新区间缝合前后邻站，避免线路断成两截（见 graphOps）
    const next = deleteStationFromGraph(stationId, { lines, stations, sections });
    setLines(next.lines);
    setStations(next.stations);
    setSections(next.sections);
    message.success('站点已删除');
  };

  const handleDeleteSection = (sectionId: string) => {
    const target = sections.find((section) => section.id === sectionId);
    if (!target) return;

    pushHistory();
    setSections((prev) => prev.filter((section) => section.id !== sectionId));
    setLines((prev) =>
      prev.map((line) => {
        if (line.id !== target.lineId) return line;
        return {
          ...line,
          sectionIds: line.sectionIds.filter((id) => id !== sectionId)
        };
      })
    );
    message.success('区间已删除');
  };

  const handleReorderLines = (newOrder: string[]) => {
    pushHistory();
    const nextLines = newOrder.map((lineId) => lines.find((line) => line.id === lineId)).filter(Boolean) as Line[];
    setLines(nextLines);
    message.success('线路顺序已更新');
  };

  // AuthPanel 走完整的登录 / 注册 / 验证 / 重置流程后，统一通过 onAuthenticated 回调
  // 交付 { token, user } —— 我们只关心持久化和切到工作台。
  const handleAuthenticated = async ({ token, user }: { token: string; user: UserProfile }) => {
    setToken(token);
    setUserProfile({ ...user, password: '' });
    refreshSavedMaps(false);
    message.success('登录成功');
  };

  const handleLogout = () => {
    revokeBlobUrl(userProfile?.avatar);
    clearToken();
    try { localStorage.removeItem(LAST_MAP_KEY); } catch { /* ignore */ }
    setUserProfile(null);
    setLines([]);
    setSections([]);
    setStations([]);
    setCurrentLineId(null);
    setCurrentMap(null);
    setSavedMaps([]);
    setMapSettings(DEFAULT_MAP_SETTINGS);
    setProfileVisible(false);
    setSettingsVisible(false);
    setMapName('');
    resetHistory();
    message.info('已退出登录');
  };

  // 「新建空白方案」：从头开始一张空画布。
  // - 有内容时弹确认（避免误清当前工作）；空画布直接执行
  // - 已经保存过的方案不会被删，仍在「我的地图」里；这里只是把当前会话清掉
  // - 同时清除 localStorage 里"上次编辑方案"指针，避免刷新又自动加载回来
  const handleNewMap = () => {
    const hasContent = lines.length > 0 || sections.length > 0 || stations.length > 0;
    const doReset = () => {
      // 用户当前的 labelDensity 选择会带到新方案里，不被默认值覆盖
      // (跨 session 也用 localStorage 兜底，所以 readLabelDensity 也能 fallback)
      const stickyLabelDensity = mapSettingsRef.current.labelDensity || readLabelDensity();
      setLines([]);
      setSections([]);
      setStations([]);
      setCurrentLineId(null);
      setCurrentMap(null);
      setMapName('');
      setMapSettings({ ...DEFAULT_MAP_SETTINGS, labelDensity: stickyLabelDensity });
      try { localStorage.removeItem(LAST_MAP_KEY); } catch { /* ignore */ }
      resetHistory();
      message.success('已新建空白方案');
    };
    if (!hasContent) {
      doReset();
      return;
    }
    Modal.confirm({
      title: '新建空白方案？',
      content: currentMap
        ? '当前方案已保存在「我的地图」，需要时可重新打开。画布即将清空。'
        : '当前方案尚未保存，未保存的修改将丢失。是否继续？',
      okText: '新建',
      cancelText: '取消',
      onOk: doReset
    });
  };

  const handleBaseMapModeChange = (nextMode: BaseMapMode) => {
    if (nextMode === mapSettings.baseMap.mode) return;

    const switchingToPlain = mapSettings.baseMap.mode === 'amap' && nextMode === 'plain';
    Modal.confirm({
      title: switchingToPlain ? '切换到纯画布？' : '切换到高德地图？',
      content: switchingToPlain
        ? '将把当前高德视图中的站点位置固化为普通画布坐标。切换后不会继续跟随真实地图缩放，但当前视觉位置会尽量保持。'
        : '高德地图使用真实经纬度定位。已有经纬度的站点会贴合底图；没有经纬度的旧站点需要拖动一次或重新定位后才会绑定真实位置。',
      okText: '确认切换',
      cancelText: '取消',
      onOk: () => {
        pushHistory();
        setCurrentLineId(null);
        setMapSettings((prev) =>
          normalizeMapSettings({
            ...prev,
            baseMap: {
              ...prev.baseMap,
              mode: nextMode
            }
          })
        );
      }
    });
  };

  // 个人中心保存：表单只动用户名 + 可选新密码。头像走单独的"点击 / 更换头像"按钮上传，
  // 不再让用户粘 URL（那个字段对普通用户难以理解，且已通过 handleProfileAvatarUpload 自带压缩上传链路）。
  const handleUpdateProfile = async (values: {
    username: string;
    password?: string;
    confirm?: string;
  }) => {
    if (!userProfile) return;

    try {
      const nextPassword =
        values.password && values.confirm && values.password === values.confirm ? values.password : undefined;
      const payload = {
        username: values.username || userProfile.username,
        password: nextPassword
      };

      const { user } = await api.updateMe(payload);
      setUserProfile({ ...user, password: '' });
      setProfileVisible(false);
      message.success('个人信息已更新');
    } catch (error: any) {
      message.error(error.message || '更新失败');
    }
  };

  const handleProfileAvatarUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    if (!userProfile) return;

    const file = event.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      message.warning('请选择图片文件');
      event.target.value = '';
      return;
    }

    try {
      const rawDataUrl = await fileToDataUrl(file);
      // 上传前先压成 ≤192px 的 JPEG，避免几 MB 的原图直接进 db。
      // 压缩失败则降级到原始 dataURL，让后端的大小校验兜底。
      let dataUrl = rawDataUrl;
      try {
        dataUrl = await compressImageDataUrl(rawDataUrl);
      } catch (e) {
        console.warn('avatar compress failed, sending original', e);
      }
      const { user } = await api.updateMe({ avatar: dataUrl });
      setUserProfile({ ...user, password: '' });
      message.success('头像已更新');
    } catch (error: any) {
      message.error(error.message || '头像更新失败');
    } finally {
      event.target.value = '';
    }
  };

  const handleOpenMapList = async () => {
    setMapsVisible(true);
    if (mapsLoading) return;
    refreshSavedMaps(true);
  };

  const handleOpenSaveMap = () => {
    if (saveMapSaving) return;
    setMapName(currentMap?.name || '');
    setSaveMapVisible(true);
  };

  const handleSaveMap = async () => {
    if (saveMapSaving) return;
    const trimmed = mapName.trim();
    const fallbackName = currentMap?.name || `我的地图 ${new Date().toLocaleString()}`;
    const name = trimmed || fallbackName;
    const wasVisible = saveMapVisible;
    setSaveMapSaving(true);
    setSaveMapVisible(false);
    message.loading({ content: '正在保存地图...', key: 'save-map', duration: 0 });
    // 保存接口只返回 id/name/时间，counts 由前端按当前内存里的数据回填，
    // 避免下次开"我的地图"前还得再请求一次列表才看得到行数。
    const counts = {
      lineCount: lines.length,
      stationCount: stations.length,
      sectionCount: sections.length
    };
    try {
      if (currentMap) {
        const { map } = await api.updateMap(currentMap.id, { name, lines, stations, sections, mapSettings });
        setCurrentMap({ ...map, ...counts });
        upsertSavedMap({ ...map, ...counts });
        setMapName('');
        try { localStorage.setItem(LAST_MAP_KEY, map.id); } catch { /* ignore */ }
        clearDirty();
        message.success({ content: '地图已覆盖保存', key: 'save-map' });
        return;
      }

      const { map } = await api.createMap({ name, lines, stations, sections, mapSettings });
      setCurrentMap({ ...map, ...counts });
      upsertSavedMap({ ...map, ...counts });
      setMapName('');
      try { localStorage.setItem(LAST_MAP_KEY, map.id); } catch { /* ignore */ }
      clearDirty();
      message.success({ content: '地图已保存', key: 'save-map' });
    } catch (error: any) {
      if (wasVisible) setSaveMapVisible(true);
      message.error({ content: error.message || '保存地图失败', key: 'save-map' });
    } finally {
      setSaveMapSaving(false);
    }
  };

  // 把服务端返回的 map 应用到本地状态，纯 setter 操作，便于复用（boot 自动加载也调它）
  const applyLoadedMap = (map: any) => {
    const loadedLines = normalizeLoadedLines(map.lines || []);
    setLines(loadedLines);
    setSections(normalizeSections(map.sections));
    setStations(Array.isArray(map.stations) ? map.stations : []);
    setMapSettings(normalizeMapSettings(map.mapSettings));
    setCurrentLineId(loadedLines[0]?.id || null);
    setCurrentMap({
      id: map.id,
      name: map.name,
      createdAt: map.createdAt,
      updatedAt: map.updatedAt
    });
    setMapName(map.name);
    resetHistory();
    try {
      localStorage.setItem(LAST_MAP_KEY, map.id);
    } catch {
      /* localStorage 满了 / 隐私模式 / 其他失败都不影响主流程 */
    }
  };

  const handleLoadMap = async (mapId: string) => {
    try {
      const { map } = await api.getMap(mapId);
      applyLoadedMap(map);
      setMapsVisible(false);
      message.success('地图已加载');
    } catch (error: any) {
      message.error(error.message || '加载地图失败');
    }
  };

  const handleDeleteMap = async (mapId: string) => {
    try {
      await api.deleteMap(mapId);
      setSavedMaps((prev) => prev.filter((item) => item.id !== mapId));

      if (currentMap?.id === mapId) {
        setCurrentMap(null);
        setMapSettings(DEFAULT_MAP_SETTINGS);
        setMapName('');
        resetHistory();
      }
      // 删的就是上次记住的那张：清掉指针，避免下次启动尝试加载不存在的方案
      try {
        if (localStorage.getItem(LAST_MAP_KEY) === mapId) {
          localStorage.removeItem(LAST_MAP_KEY);
        }
      } catch { /* ignore */ }

      message.success('地图已删除');
    } catch (error: any) {
      message.error(error.message || '删除地图失败');
    }
  };

  const openRenameMapModal = (map: MapSummaryState) => {
    setRenameMapModal({ visible: true, mapId: map.id, name: map.name, saving: false });
  };

  const closeRenameMapModal = () => {
    setRenameMapModal({ visible: false, mapId: null, name: '', saving: false });
  };

  const handleConfirmRenameMap = async () => {
    const { mapId, name } = renameMapModal;
    const trimmed = name.trim();
    if (!mapId) return;
    if (!trimmed) {
      message.warning('地图名称不能为空');
      return;
    }
    setRenameMapModal(prev => ({ ...prev, saving: true }));
    try {
      // 只发 name 字段，后端 storage.updateMap 会保留 lines/stations/sections/mapSettings
      const { map } = await api.updateMap(mapId, { name: trimmed });
      setSavedMaps(prev =>
        prev
          .map(item =>
            item.id === mapId ? { ...item, name: map.name, updatedAt: map.updatedAt } : item
          )
          .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      );
      if (currentMap?.id === mapId) {
        setCurrentMap({ ...currentMap, name: map.name, updatedAt: map.updatedAt });
        setMapName(map.name);
      }
      closeRenameMapModal();
      message.success('地图已重命名');
    } catch (error: any) {
      setRenameMapModal(prev => ({ ...prev, saving: false }));
      message.error(error?.message || '重命名失败');
    }
  };

  const handleDuplicateMap = async (mapId: string) => {
    if (duplicatingMapId) return;
    setDuplicatingMapId(mapId);
    try {
      const { map } = await api.getMap(mapId);
      const dupName = `${map.name} 副本`;
      const { map: created } = await api.createMap({
        name: dupName,
        lines: map.lines || [],
        stations: map.stations || [],
        sections: map.sections || [],
        mapSettings: map.mapSettings
      });
      upsertSavedMap({
        ...created,
        lineCount: (map.lines || []).length,
        stationCount: (map.stations || []).length,
        sectionCount: (map.sections || []).length
      });
      message.success(`已创建副本 “${dupName}”`);
    } catch (error: any) {
      message.error(error?.message || '复制失败');
    } finally {
      setDuplicatingMapId(null);
    }
  };

  const handleConfirmSegments = async (config: VideoExportConfig) => {
    if (!stageRef.current) {
      message.error('画布尚未准备好');
      return;
    }

    setVideoModalOpen(false);
    setIsExporting(true);

    try {
      const blob = await exportVideoFromStage({
        stage: stageRef.current,
        segments: config.segments,
        lines,
        stations,
        sections,
        settings: mapSettings,
        title: config.title,
        subtitle: config.subtitle,
        titleDurationSec: config.titleDurationSec,
        fetchAmapStaticMap: api.getAmapStaticMap,
        onWarn: (msg) => message.warning(msg)
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `metro-demo-${Date.now()}.webm`;
      anchor.click();
      URL.revokeObjectURL(url);
      message.success('视频导出完成，已开始下载');
    } catch (error: any) {
      console.error(error);
      message.error(error?.message || '导出失败，请重试');
    } finally {
      setIsExporting(false);
    }
  };

  // 把 AI 返回的 operations 列表逐条 apply 到 lines / stations / sections 上。
  // 一组 operations 算作一次撤销单位（开头只 pushHistory 一次）。
  // 所有操作走"新数组替换"路径，避免半截 React state 引用旧的另一半。
  const applyAIOperations = (operations: AIOperation[]) => {
    if (!operations.length) return 0;
    pushHistory();
    let nextLines = [...lines];
    let nextStations = [...stations];
    let nextSections = [...sections];
    let applied = 0;

    for (const op of operations) {
      switch (op.type) {
        case 'create_line': {
          // 创建新线路 + 相邻站点之间生成 sections
          const lineId = createId();
          const sectionIds: string[] = [];
          const newSections: Section[] = [];
          for (let i = 0; i < op.stationIds.length - 1; i += 1) {
            const sectionId = createId();
            sectionIds.push(sectionId);
            newSections.push({
              id: sectionId,
              lineId,
              startStationId: op.stationIds[i],
              endStationId: op.stationIds[i + 1]
            });
          }
          nextLines.push({ id: lineId, name: op.name, color: op.color, stationIds: [...op.stationIds], sectionIds });
          nextSections = [...nextSections, ...newSections];
          applied += 1;
          break;
        }
        case 'create_line_via_extension': {
          // 新线路 = 锚点（已存在）+ N 个新站点，沿"远离方向参照点"等距外推
          const anchor = nextStations.find((s) => s.id === op.anchorStationId);
          if (!anchor) break;
          const newNames = (op.newStationNames || []).filter((n) => typeof n === 'string' && n.trim());
          if (newNames.length === 0) break;

          // 方向参照点：
          // 1) op.directionAwayFromStationId 显式给了 → 直接用
          // 2) 否则，在 anchor 所在的其他线路上找它的邻站作为方向参照（远离邻站、朝外延伸）
          // 3) 都找不到 → 默认 +x 方向 + 固定步长
          let reference: Station | null = null;
          if (op.directionAwayFromStationId) {
            reference = nextStations.find((s) => s.id === op.directionAwayFromStationId) || null;
          }
          if (!reference) {
            // 在所有现有线路里找 anchor 的邻居
            for (const candidateLine of nextLines) {
              const idx = candidateLine.stationIds.indexOf(anchor.id);
              if (idx < 0) continue;
              const neighborId = candidateLine.stationIds[idx - 1] || candidateLine.stationIds[idx + 1];
              if (neighborId) {
                reference = nextStations.find((s) => s.id === neighborId) || null;
                if (reference) break;
              }
            }
          }

          // 方向向量 + 步长
          let dx: number;
          let dy: number;
          let dLng: number | null = null;
          let dLat: number | null = null;
          if (reference) {
            dx = anchor.x - reference.x;
            dy = anchor.y - reference.y;
            if (typeof anchor.lng === 'number' && typeof reference.lng === 'number') {
              dLng = anchor.lng - reference.lng;
            }
            if (typeof anchor.lat === 'number' && typeof reference.lat === 'number') {
              dLat = anchor.lat - reference.lat;
            }
            // 太近的话给个最小步长，避免新站全挤在一起
            const magnitude = Math.hypot(dx, dy);
            if (magnitude < 30) {
              const fallback = 80;
              dx = magnitude === 0 ? fallback : (dx / magnitude) * fallback;
              dy = magnitude === 0 ? 0 : (dy / magnitude) * fallback;
            }
          } else {
            // 兜底：默认向 +x，每步 80 像素
            dx = 80;
            dy = 0;
          }

          const newStationsList: Station[] = newNames.map((rawName, i) => {
            const step = i + 1;
            return {
              id: createId(),
              name: rawName.trim(),
              x: anchor.x + dx * step,
              y: anchor.y + dy * step,
              ...(dLng !== null ? { lng: anchor.lng! + dLng * step } : {}),
              ...(dLat !== null ? { lat: anchor.lat! + dLat * step } : {})
            };
          });
          const chain = [anchor, ...newStationsList];
          const newSectionList: Section[] = [];
          const lineId = createId();
          for (let i = 0; i < chain.length - 1; i += 1) {
            newSectionList.push({
              id: createId(),
              lineId,
              startStationId: chain[i].id,
              endStationId: chain[i + 1].id
            });
          }
          nextStations = [...nextStations, ...newStationsList];
          nextSections = [...nextSections, ...newSectionList];
          nextLines.push({
            id: lineId,
            name: op.name,
            color: op.color,
            stationIds: chain.map((s) => s.id),
            sectionIds: newSectionList.map((s) => s.id)
          });
          applied += 1;
          break;
        }
        case 'recolor_line':
          nextLines = nextLines.map((l) => (l.id === op.lineId ? { ...l, color: op.color } : l));
          applied += 1;
          break;
        case 'rename_line':
          nextLines = nextLines.map((l) => (l.id === op.lineId ? { ...l, name: op.name } : l));
          applied += 1;
          break;
        case 'delete_line': {
          nextLines = nextLines.filter((l) => l.id !== op.lineId);
          nextSections = nextSections.filter((s) => s.lineId !== op.lineId);
          applied += 1;
          break;
        }
        case 'attach_station_to_line': {
          const line = nextLines.find((l) => l.id === op.lineId);
          if (!line) break;
          if (line.stationIds.includes(op.stationId)) break;
          const isStart = op.position === 'start';
          const adjacent = isStart ? line.stationIds[0] : line.stationIds[line.stationIds.length - 1];
          if (!adjacent) break;
          const sectionId = createId();
          const newSection: Section = {
            id: sectionId,
            lineId: op.lineId,
            startStationId: isStart ? op.stationId : adjacent,
            endStationId: isStart ? adjacent : op.stationId
          };
          nextSections = [...nextSections, newSection];
          nextLines = nextLines.map((l) =>
            l.id === op.lineId
              ? {
                  ...l,
                  stationIds: isStart ? [op.stationId, ...l.stationIds] : [...l.stationIds, op.stationId],
                  sectionIds: isStart ? [sectionId, ...l.sectionIds] : [...l.sectionIds, sectionId]
                }
              : l
          );
          applied += 1;
          break;
        }
        case 'create_station_between': {
          const line = nextLines.find((l) => l.id === op.lineId);
          if (!line) break;
          const aIdx = line.stationIds.indexOf(op.afterStationId);
          const bIdx = line.stationIds.indexOf(op.beforeStationId);
          if (aIdx < 0 || bIdx < 0 || Math.abs(aIdx - bIdx) !== 1) break;
          const stationA = nextStations.find((s) => s.id === op.afterStationId);
          const stationB = nextStations.find((s) => s.id === op.beforeStationId);
          if (!stationA || !stationB) break;
          // 批量：N 个新站点等距分布在 A→B 之间，比例 1/(N+1), 2/(N+1), ...
          // 原 A→B 区间一拆为 N+1 段
          const names = (op.names || []).filter((n) => typeof n === 'string' && n.trim());
          if (names.length === 0) break;
          const insertIdx = Math.min(aIdx, bIdx);
          // 注意方向：op.afterStationId 在线路 stationIds 里的"前一位"，所以从这一端开始插
          const fromStation = line.stationIds[insertIdx] === op.afterStationId ? stationA : stationB;
          const toStation = fromStation === stationA ? stationB : stationA;
          const newStations: Station[] = names.map((rawName, i) => {
            const t = (i + 1) / (names.length + 1);
            return {
              id: createId(),
              name: rawName.trim(),
              x: fromStation.x + (toStation.x - fromStation.x) * t,
              y: fromStation.y + (toStation.y - fromStation.y) * t,
              ...(typeof fromStation.lng === 'number' && typeof toStation.lng === 'number'
                ? { lng: fromStation.lng + (toStation.lng - fromStation.lng) * t }
                : {}),
              ...(typeof fromStation.lat === 'number' && typeof toStation.lat === 'number'
                ? { lat: fromStation.lat + (toStation.lat - fromStation.lat) * t }
                : {})
            };
          });
          const oldSectionId = line.sectionIds[insertIdx];
          // 构造新区间链：fromStation → new[0] → new[1] → ... → toStation
          const chainIds = [fromStation.id, ...newStations.map((s) => s.id), toStation.id];
          const newSections: Section[] = [];
          for (let i = 0; i < chainIds.length - 1; i += 1) {
            newSections.push({
              id: createId(),
              lineId: op.lineId,
              startStationId: chainIds[i],
              endStationId: chainIds[i + 1]
            });
          }
          nextStations = [...nextStations, ...newStations];
          nextSections = nextSections.filter((s) => s.id !== oldSectionId).concat(newSections);
          nextLines = nextLines.map((l) =>
            l.id === op.lineId
              ? {
                  ...l,
                  stationIds: [
                    ...l.stationIds.slice(0, insertIdx + 1),
                    ...newStations.map((s) => s.id),
                    ...l.stationIds.slice(insertIdx + 1)
                  ],
                  sectionIds: [
                    ...l.sectionIds.slice(0, insertIdx),
                    ...newSections.map((s) => s.id),
                    ...l.sectionIds.slice(insertIdx + 1)
                  ]
                }
              : l
          );
          applied += 1;
          break;
        }
        case 'create_station_at_line_end': {
          const line = nextLines.find((l) => l.id === op.lineId);
          if (!line || line.stationIds.length < 2) break;
          const names = (op.names || []).filter((n) => typeof n === 'string' && n.trim());
          if (names.length === 0) break;
          const isStart = op.position === 'start';
          // 取该端点的最后 2 个站点：endStation 是最末端，beforeEnd 是倒数第二
          // 方向向量 = endStation - beforeEnd；批量延伸 N 站，每一站继续沿该向量再外推一段
          const endStationId = isStart ? line.stationIds[0] : line.stationIds[line.stationIds.length - 1];
          const beforeEndId = isStart ? line.stationIds[1] : line.stationIds[line.stationIds.length - 2];
          const endStation = nextStations.find((s) => s.id === endStationId);
          const beforeEnd = nextStations.find((s) => s.id === beforeEndId);
          if (!endStation || !beforeEnd) break;
          const dx = endStation.x - beforeEnd.x;
          const dy = endStation.y - beforeEnd.y;
          const dLng = typeof endStation.lng === 'number' && typeof beforeEnd.lng === 'number'
            ? endStation.lng - beforeEnd.lng
            : null;
          const dLat = typeof endStation.lat === 'number' && typeof beforeEnd.lat === 'number'
            ? endStation.lat - beforeEnd.lat
            : null;
          // 一串新站点：第 i 个在 endStation 沿向量再外推 (i+1) 段距离
          const newStations: Station[] = names.map((rawName, i) => {
            const step = i + 1;
            return {
              id: createId(),
              name: rawName.trim(),
              x: endStation.x + dx * step,
              y: endStation.y + dy * step,
              ...(dLng !== null ? { lng: endStation.lng! + dLng * step } : {}),
              ...(dLat !== null ? { lat: endStation.lat! + dLat * step } : {})
            };
          });
          // 配套 sections：把每相邻两站连上
          // 顺序：从原端点向外（end 方向: end → new[0] → new[1] ... / start 方向: new[N-1] → ... → new[0] → end）
          const newSections: Section[] = [];
          if (isStart) {
            // start 方向：插到线路开头时，区间方向是 [newest...new[0], end]
            // 但为了 stationIds/sectionIds 对齐，倒序构造：
            const reversed = [...newStations].reverse();  // new[N-1] ... new[0]
            const chain = [...reversed, endStation];  // chain[i] → chain[i+1]
            for (let i = 0; i < chain.length - 1; i += 1) {
              newSections.push({
                id: createId(),
                lineId: op.lineId,
                startStationId: chain[i].id,
                endStationId: chain[i + 1].id
              });
            }
          } else {
            const chain = [endStation, ...newStations];
            for (let i = 0; i < chain.length - 1; i += 1) {
              newSections.push({
                id: createId(),
                lineId: op.lineId,
                startStationId: chain[i].id,
                endStationId: chain[i + 1].id
              });
            }
          }
          nextStations = [...nextStations, ...newStations];
          nextSections = [...nextSections, ...newSections];
          nextLines = nextLines.map((l) =>
            l.id === op.lineId
              ? {
                  ...l,
                  // start: 把 new[N-1]...new[0] 接在原 stationIds 前；end: new[0]...new[N-1] 接在后
                  stationIds: isStart
                    ? [...[...newStations].reverse().map((s) => s.id), ...l.stationIds]
                    : [...l.stationIds, ...newStations.map((s) => s.id)],
                  sectionIds: isStart
                    ? [...newSections.map((s) => s.id), ...l.sectionIds]
                    : [...l.sectionIds, ...newSections.map((s) => s.id)]
                }
              : l
          );
          applied += 1;
          break;
        }
        case 'rename_station':
          nextStations = nextStations.map((s) => (s.id === op.stationId ? { ...s, name: op.name } : s));
          applied += 1;
          break;
        case 'delete_station': {
          // 与手动删站共用同一份逻辑：删中间站会自动缝合前后邻站
          const next = deleteStationFromGraph(op.stationId, {
            lines: nextLines,
            stations: nextStations,
            sections: nextSections
          });
          nextLines = next.lines;
          nextStations = next.stations;
          nextSections = next.sections;
          applied += 1;
          break;
        }
      }
    }

    setLines(nextLines);
    setStations(nextStations);
    setSections(nextSections);
    return applied;
  };

  // 把一个 AI 操作 op 转成人类能读的中文摘要，给确认弹窗展示。
  // 用当前的 lines / stations 解析 id → 名字；解析不到的 fallback 到 id 前 6 位。
  const summarizeOperation = (op: AIOperation): string => {
    const lineName = (id: string) => lines.find((l) => l.id === id)?.name || `#${id.slice(0, 6)}`;
    const stationName = (id: string) => stations.find((s) => s.id === id)?.name || `#${id.slice(0, 6)}`;
    switch (op.type) {
      case 'create_line':
        return `新建线路「${op.name}」（${op.color}），共 ${op.stationIds.length} 个站点`;
      case 'create_line_via_extension':
        return `新建线路「${op.name}」（${op.color}），从「${stationName(op.anchorStationId)}」延伸 ${op.newStationNames.length} 个新站：${op.newStationNames.join('、')}`;
      case 'recolor_line':
        return `「${lineName(op.lineId)}」颜色改为 ${op.color}`;
      case 'rename_line':
        return `线路「${lineName(op.lineId)}」改名为「${op.name}」`;
      case 'delete_line':
        return `删除线路「${lineName(op.lineId)}」`;
      case 'attach_station_to_line':
        return `把「${stationName(op.stationId)}」接到「${lineName(op.lineId)}」的${op.position === 'start' ? '起点' : '终点'}`;
      case 'create_station_between':
        return `在「${lineName(op.lineId)}」上「${stationName(op.afterStationId)}」和「${stationName(op.beforeStationId)}」之间新增 ${op.names.length} 个站：${op.names.join('、')}`;
      case 'create_station_at_line_end':
        return `在「${lineName(op.lineId)}」的${op.position === 'start' ? '起点' : '终点'}延伸 ${op.names.length} 个新站：${op.names.join('、')}`;
      case 'rename_station':
        return `站点「${stationName(op.stationId)}」改名为「${op.name}」`;
      case 'delete_station':
        return `删除站点「${stationName(op.stationId)}」`;
    }
  };

  // 让 AI 分析意图（多轮 + 流式）：传完整对话历史 + 当前最新地图状态。
  // onDelta 把 AI 正在生成的文本（累计）实时回吐给弹窗。
  // signal 让弹窗在关闭 / 重新提交时取消流。
  // mapState 每次现算，确保即使在多轮里也是最新状态。
  const handleAiAnalyzeStream = async (
    messages: { role: 'user' | 'assistant'; content: string }[],
    onDelta: (text: string) => void,
    signal?: AbortSignal
  ) => {
    setAiBusy(true);
    try {
      const mapState = {
        lines: lines.map((l) => ({
          id: l.id,
          name: l.name,
          color: l.color,
          stationIds: [...l.stationIds]
        })),
        stations: stations.map((s) => ({ id: s.id, name: s.name }))
      };
      const result = await api.aiEditStream({ messages, mapState }, { onDelta, signal });
      return {
        explanation: result.explanation || '',
        operations: result.operations || [],
        summaries: (result.operations || []).map(summarizeOperation),
        skippedCount: result.skipped?.length || 0
      };
    } finally {
      setAiBusy(false);
    }
  };

  const handleAiApply = (operations: AIOperation[]) => {
    return applyAIOperations(operations);
  };

  // ── 命令行（v1）：新 handler（AIOperation 之外的命令独有变更）+ 执行器 ──────────
  // 建空线路（自动设为当前线路）
  const createEmptyLine = (name: string, color: string) => {
    pushHistory();
    const id = createId();
    // 同步更新 ref（不等 useEffect），让紧接着的命令（如省略线名的 connect）立刻见到这条新线
    const next = [...linesRef.current, { id, name, color, stationIds: [], sectionIds: [] }];
    linesRef.current = next;
    setLines(next);
    currentLineIdRef.current = id;
    setCurrentLineId(id);
  };

  // 按顺序连接已有站点：空线路=初始化路径；非空=从端点延伸（首站为端点已在 resolver 校验）
  const connectStationsOnLine = (lineId: string, ids: string[]) => {
    const line = linesRef.current.find(l => l.id === lineId);
    if (!line) return;
    pushHistory();
    const newSections: Section[] = [];
    for (let i = 0; i < ids.length - 1; i += 1) {
      newSections.push({ id: createId(), lineId, startStationId: ids[i], endStationId: ids[i + 1] });
    }
    const newIds = newSections.map(s => s.id);
    let nextStationIds: string[];
    let nextSectionIds: string[];
    if (line.stationIds.length === 0) {
      nextStationIds = [...ids];
      nextSectionIds = newIds;
    } else if (ids[0] === line.stationIds[line.stationIds.length - 1]) {
      // 首站=末端点 → 往后追加
      nextStationIds = [...line.stationIds, ...ids.slice(1)];
      nextSectionIds = [...line.sectionIds, ...newIds];
    } else {
      // 首站=起点端点 → 反向前插（保持简单路径）
      nextStationIds = [...ids.slice(1).reverse(), ...line.stationIds];
      nextSectionIds = [...newIds.slice().reverse(), ...line.sectionIds];
    }
    const nextLines = linesRef.current.map(l => (l.id === lineId ? { ...l, stationIds: nextStationIds, sectionIds: nextSectionIds } : l));
    const nextSections = [...sectionsRef.current, ...newSections];
    linesRef.current = nextLines;
    sectionsRef.current = nextSections;
    setLines(nextLines);
    setSections(nextSections);
  };

  // 建独立站点（不挂任何线路）
  const addStationByCommand = (name: string, x: number, y: number) => {
    pushHistory();
    const next = [...stationsRef.current, { id: createId(), name, x, y }];
    stationsRef.current = next;
    setStations(next);
  };

  // 设置/清空某区间的途经点；找不到匹配区间返回 false（由执行器报错）
  const setSectionWaypointsByCommand = (lineId: string, aId: string, bId: string, points: { x: number; y: number }[]): boolean => {
    const target = sectionsRef.current.find(
      s => s.lineId === lineId &&
        ((s.startStationId === aId && s.endStationId === bId) || (s.startStationId === bId && s.endStationId === aId))
    );
    if (!target) return false;
    pushHistory();
    const oriented = target.startStationId === aId ? points : [...points].reverse();
    const capped = oriented.slice(0, 6).map(p => ({ x: p.x, y: p.y }));
    const next = sectionsRef.current.map(s => (s.id === target.id ? { ...s, waypoints: capped.length ? capped : undefined } : s));
    sectionsRef.current = next;
    setSections(next);
    return true;
  };

  const executeCommand = (resolved: ResolvedCommand): { ok: boolean; message: string } => {
    switch (resolved.kind) {
      case 'error':
        return { ok: false, message: resolved.message };
      case 'guide':
        if (resolved.topic === 'colors') {
          return { ok: true, message: '配色：blue red green yellow purple cyan pink orange ，或 #rrggbb ，或序号 1-8' };
        }
        return { ok: true, message: '命令总览：create line / line connect / station / extend / insert / attach / recolor / rename / delete / select / waypoint / zoom / fit / reset / center / style / theme / corner / undo / redo / save / new' };
      case 'ops':
        applyAIOperations(resolved.ops);
        return { ok: true, message: resolved.summary };
      case 'effect': {
        const e = resolved.effect;
        if (mapSettingsRef.current.baseMap.mode === 'amap' && (e.type === 'add_station' || e.type === 'set_waypoints')) {
          return { ok: false, message: '高德模式暂不支持坐标放置，请切到纯画布，或直接在画布上操作' };
        }
        switch (e.type) {
          case 'create_empty_line': createEmptyLine(e.name, e.color); break;
          case 'connect': connectStationsOnLine(e.lineId, e.stationIds); break;
          case 'add_station': addStationByCommand(e.name, e.x, e.y); break;
          case 'set_waypoints':
            if (!setSectionWaypointsByCommand(e.lineId, e.startStationId, e.endStationId, e.points)) {
              return { ok: false, message: '找不到这两个站之间的区间' };
            }
            break;
          case 'clear_waypoints':
            if (!setSectionWaypointsByCommand(e.lineId, e.startStationId, e.endStationId, [])) {
              return { ok: false, message: '找不到这两个站之间的区间' };
            }
            break;
        }
        return { ok: true, message: resolved.summary };
      }
      case 'action': {
        if (resolved.undoable) pushHistory();
        const a = resolved.action;
        switch (a.type) {
          case 'zoom':
          case 'zoom_in':
          case 'zoom_out':
          case 'fit':
          case 'reset':
          case 'center':
            // 视图类下发到 Canvas（它才持有 scale/position/amapRef）
            setViewCmd({ seq: Date.now() + Math.random(), action: a });
            break;
          case 'set_style': setMapSettings(prev => normalizeMapSettings({ ...prev, mapStyle: a.mapStyle })); break;
          case 'set_theme': setMapSettings(prev => normalizeMapSettings({ ...prev, canvasTheme: a.canvasTheme })); break;
          case 'set_corner': setMapSettings(prev => normalizeMapSettings({ ...prev, cornerRadius: a.cornerRadius })); break;
          case 'select_line': setCurrentLineId(a.lineId); break;
          case 'undo': handleUndo(); break;
          case 'redo': handleRedo(); break;
          case 'save': handleSaveMap(); break;
          case 'new': handleNewMap(); break;
        }
        return { ok: true, message: resolved.summary };
      }
    }
  };

  // 命令栏入口：用 ref 取最新地图状态做上下文，解释 + 执行，返回结果给命令栏展示
  const runCommand = (input: string): { ok: boolean; message: string } => {
    const ctx = {
      lines: linesRef.current.map(l => ({ id: l.id, name: l.name, color: l.color, stationIds: l.stationIds })),
      stations: stationsRef.current.map(s => ({ id: s.id, name: s.name, x: s.x, y: s.y })),
      currentLineId: currentLineIdRef.current
    };
    return executeCommand(interpretCommand(input, ctx));
  };

  const handleExportImage = () => {
    if (!stageRef.current) {
      message.error('无法获取画布');
      return;
    }

    try {
      const stage = stageRef.current;
      const currentScale = stage.scaleX();
      const currentX = stage.x();
      const currentY = stage.y();

      stage.scale({ x: 1, y: 1 });
      stage.position({ x: 0, y: 0 });

      const stageWidth = stage.width();
      const stageHeight = stage.height();

      let minX = 0;
      let minY = 0;
      let maxX = stageWidth;
      let maxY = stageHeight;

      if (stations.length > 0) {
        minX = Math.min(...stations.map((station) => station.x));
        minY = Math.min(...stations.map((station) => station.y));
        maxX = Math.max(...stations.map((station) => station.x));
        maxY = Math.max(...stations.map((station) => station.y));
      }

      const padding = 100;
      const contentWidth = maxX - minX + padding * 2;
      const contentHeight = maxY - minY + padding * 2;
      const exportWidth = Math.max(contentWidth, 800);
      const exportHeight = Math.max(contentHeight, 600);

      stage.width(exportWidth);
      stage.height(exportHeight);

      const centerX = (exportWidth - (maxX - minX)) / 2;
      const centerY = (exportHeight - (maxY - minY)) / 2;
      stage.position({ x: centerX - minX, y: centerY - minY });

      const dataUrl = stage.toDataURL({
        pixelRatio: 2,
        mimeType: 'image/png',
        quality: 1
      });

      const link = document.createElement('a');
      link.download = `metro-line-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.png`;
      link.href = dataUrl;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      stage.scale({ x: currentScale, y: currentScale });
      stage.position({ x: currentX, y: currentY });
      stage.width(stageWidth);
      stage.height(stageHeight);
      message.success('图片导出成功');
    } catch (error) {
      console.error('导出图片失败:', error);
      message.error('导出图片失败，请重试');
    }
  };

  const displayName = userProfile?.username || text.defaultUserName;
  const displayInitial = (userProfile?.username || userProfile?.email || userProfile?.phone || 'M').charAt(0).toUpperCase();
  const mapDisplayName = currentMap?.name || text.unnamedMap;

  // 邮箱脱敏：dro****@example.com 这种，dropdown 展示用。
  // 没邮箱的 legacy 账号兜底展示已脱敏的手机号。
  const maskedEmail = (() => {
    const e = userProfile?.email || '';
    if (e) {
      const [local, domain] = e.split('@');
      if (!local || !domain) return e;
      if (local.length <= 3) return `${local}@${domain}`;
      return `${local.slice(0, 3)}****@${domain}`;
    }
    const p = userProfile?.phone || '';
    if (!p) return '';
    return p.length >= 11
      ? `+86 ${p.slice(0, 3)}****${p.slice(-4)}`
      : `+86 ${p}`;
  })();

  // 画布左上角浮动的方案名 chip 被点击时的行为：
  // - 已经保存过 → 直接进重命名小弹窗
  // - 还没保存过 → 走"保存地图"流程
  const handleClickMapNameChip = () => {
    if (currentMap) {
      openRenameMapModal(currentMap);
    } else {
      handleOpenSaveMap();
    }
  };

  // 右上角头像 dropdown 的菜单项。邮箱置顶展示（legacy 账号兜底脱敏手机号），三个常用入口 + 危险操作分隔。
  const userMenuItems = [
    {
      key: 'identity',
      disabled: true,
      label: (
        <span style={{ color: 'var(--color-text-muted)', fontSize: 'var(--font-size-meta)' }}>
          {maskedEmail}
        </span>
      )
    },
    { type: 'divider' as const },
    {
      // 文件类：新建 + 打开。"新建空白方案"放最前面，因为这是"保存了之后想开个新的"最自然的入口
      key: 'new-map',
      icon: <FileAddOutlined />,
      label: '新建空白方案',
      onClick: handleNewMap
    },
    {
      key: 'maps',
      icon: <FolderOpenOutlined />,
      label: '我的地图',
      onClick: handleOpenMapList
    },
    { type: 'divider' as const },
    {
      // 账号类
      key: 'profile',
      icon: <UserOutlined />,
      label: '个人中心',
      onClick: () => setProfileVisible(true)
    },
    {
      key: 'settings',
      icon: <SettingOutlined />,
      label: '设置',
      onClick: () => setSettingsVisible(true)
    },
    { type: 'divider' as const },
    {
      key: 'logout',
      icon: <LogoutOutlined />,
      label: '退出登录',
      danger: true,
      onClick: handleLogout
    }
  ];

  const antdThemeConfig = useMemo(
    () => ({
      algorithm: resolvedInterfaceTheme === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
      // 亮色 = 暖纸面主题（与 styles.css :root 的 token 对齐）；暗色保持原蓝色主题不动。
      token:
        resolvedInterfaceTheme === 'dark'
          ? {
              colorPrimary: '#2563eb',
              borderRadius: 8
            }
          : {
              colorPrimary: '#36455c',
              borderRadius: 8,
              colorText: '#1f2733',
              colorTextSecondary: '#57606e',
              colorBorder: '#d9d0bc',
              colorBorderSecondary: '#e7e0d1',
              colorBgLayout: '#f6f2e9'
            }
    }),
    [resolvedInterfaceTheme]
  );

  if (!userProfile) {
    return (
      <ConfigProvider theme={antdThemeConfig}>
        <AntdApp className="metro-antd-root" data-interface-theme={resolvedInterfaceTheme}>
          <div className="auth-layout" data-interface-theme={resolvedInterfaceTheme}>
            <AuthPanel onAuthenticated={handleAuthenticated} />
          </div>
        </AntdApp>
      </ConfigProvider>
    );
  }

  return (
    <ConfigProvider theme={antdThemeConfig}>
      <AntdApp className="metro-antd-root" data-interface-theme={resolvedInterfaceTheme}>
    <div className="metro-app-shell" data-interface-theme={resolvedInterfaceTheme}>
      <Layout className="metro-workbench">
        <Header className="metro-header">
          <div className="app-header">
            <section className="metro-brand-panel">
              {/* 移动端汉堡按钮：仅 ≤768px 通过 CSS 显示，点击切换抽屉式侧栏 */}
              <button
                type="button"
                className="metro-mobile-toggle"
                aria-label="打开侧栏"
                onClick={() => setIsMobileSidebarOpen((prev) => !prev)}
              >
                <MenuOutlined />
              </button>
              <div className="metro-brand-mark">
                <span className="metro-brand-mark__dot" />
                <div className="metro-brand-title">Metro Designer</div>
              </div>
              {/* 方案名 chip 从画布顶部挪到 header 这里：
                  既保留"我在编辑哪张图"的视觉锚，又不占用画布空间 */}
              <Tooltip title={currentMap ? '点击重命名当前方案' : '点击保存为新方案'}>
                <button
                  type="button"
                  className="metro-header-mapchip"
                  onClick={handleClickMapNameChip}
                >
                  <EditOutlined className="metro-header-mapchip__icon" />
                  <span className="metro-header-mapchip__name">{mapDisplayName}</span>
                </button>
              </Tooltip>
            </section>

            <section className="metro-toolbar-panel">
              <Toolbar
                language={language}
                onExportImage={handleExportImage}
                onOpenVideoModal={() => setVideoModalOpen(true)}
                onUndo={handleUndo}
                onRedo={handleRedo}
                canUndo={canUndo}
                canRedo={canRedo}
              />
            </section>

            <section className="metro-user-panel">
              {/* AI 助手按钮：圆形 + 边缘 conic-gradient 慢旋 + 微光晕，全平台一致 */}
              <Tooltip title="AI 助手 —— 用自然语言编辑线路图">
                <button
                  type="button"
                  className="metro-header-ai-btn"
                  aria-label="打开 AI 助手"
                  onClick={() => setAiModalOpen(true)}
                >
                  <span className="metro-header-ai-btn__icon">
                    <ThunderboltOutlined />
                  </span>
                </button>
              </Tooltip>
              <Button
                type="primary"
                className="metro-header-save-btn"
                icon={<SaveOutlined />}
                loading={saveMapSaving}
                onClick={handleOpenSaveMap}
              >
                <span className="metro-header-save-btn__label">
                  {currentMap ? text.overwriteSave : text.saveMap}
                </span>
                {dirty ? (
                  <span
                    title="有未保存的修改"
                    style={{
                      display: 'inline-block',
                      width: 7,
                      height: 7,
                      marginLeft: 6,
                      borderRadius: '50%',
                      background: '#faad14',
                      verticalAlign: 'middle'
                    }}
                  />
                ) : null}
              </Button>

              <Dropdown menu={{ items: userMenuItems }} trigger={['click']} placement="bottomRight">
                <button type="button" className="user-chip user-chip--trigger">
                  <Avatar size={28} src={userProfile.avatar} style={{ backgroundColor: 'var(--color-primary-600)' }}>
                    {userProfile.avatar ? null : displayInitial}
                  </Avatar>
                  <span className="user-chip__name">{displayName}</span>
                  <DownOutlined style={{ fontSize: 10, color: 'var(--color-text-muted)' }} />
                </button>
              </Dropdown>
            </section>
          </div>
        </Header>

        <Layout className="metro-body">
          {/* 移动端抽屉遮罩：点击关闭。桌面端 CSS 隐藏。 */}
          <div
            className={`metro-mobile-overlay${isMobileSidebarOpen ? ' is-active' : ''}`}
            onClick={() => setIsMobileSidebarOpen(false)}
            aria-hidden="true"
          />
          <Sider
            className={`metro-sider${isMobileSidebarOpen ? ' is-mobile-open' : ''}`}
            width={252}
          >
            <Sidebar
              language={language}
              lines={lines}
              stations={stations}
              currentLineId={currentLineId}
              onSelectLine={(id) => { handleSelectLine(id); setIsMobileSidebarOpen(false); }}
              onDeselectLine={handleDeselectLine}
              onAddLine={(name, color) => {
                const ok = handleAddLine(name, color);
                if (ok) setIsMobileSidebarOpen(false);
                return ok;
              }}
              onDeleteLine={handleDeleteLine}
              onChangeLineColor={handleChangeLineColor}
              onChangeLineName={handleChangeLineName}
              onRemoveStationFromLine={handleRemoveStationFromLine}
              onReorderStations={handleReorderStations}
              onReorderLines={handleReorderLines}
            />
          </Sider>

          <Content className="metro-content">
            <div className="metro-canvas-stage">

              <Canvas
                currentLineId={currentLineId}
                lines={lines}
                sections={sections}
                stations={stations}
                mapSettings={mapSettings}
                language={language}
                onAddStation={handleAddStation}
                onUpdateStation={handleUpdateStation}
                onAddStationToLine={handleAddStationToLine}
                onRenameStation={handleRenameStation}
                onDeleteSection={handleDeleteSection}
                onReorderStations={handleReorderStations}
                onDeleteStation={handleDeleteStation}
                onUpdateStations={setStations}
                onUpdateSection={handleUpdateSection}
                onBeginInteraction={pushHistory}
                onMapSettingsChange={(settings) => setMapSettings(normalizeMapSettings(settings))}
                onStageReady={(stage) => {
                  stageRef.current = stage;
                }}
                viewCommand={viewCmd}
              />
              <CommandBar onSubmit={runCommand} inputRef={commandInputRef} />
            </div>
          </Content>
        </Layout>

        <VideoExportModal
          open={videoModalOpen}
          lines={lines}
          stations={stations}
          defaultTitle={currentMap?.name || '城市轨道线网历程'}
          onCancel={() => setVideoModalOpen(false)}
          onConfirm={handleConfirmSegments}
        />

        <AIAssistantModal
          open={aiModalOpen}
          busy={aiBusy}
          onAnalyzeStream={handleAiAnalyzeStream}
          onApply={handleAiApply}
          onCancel={() => setAiModalOpen(false)}
        />

        <DraggableModal
          title={currentMap ? '覆盖保存当前地图' : '保存地图'}
          open={saveMapVisible}
          onCancel={() => setSaveMapVisible(false)}
          onOk={handleSaveMap}
          confirmLoading={saveMapSaving}
          okText={currentMap ? '覆盖保存' : '保存'}
          cancelText="取消"
        >
          <Input
            value={mapName}
            onChange={(event) => setMapName(event.target.value)}
            placeholder="请输入地图名称（可选）"
            maxLength={40}
          />
        </DraggableModal>

        <DraggableModal
          title="我的地图"
          open={mapsVisible}
          onCancel={() => { setMapsVisible(false); setMapsSearchKeyword(''); }}
          footer={null}
          width={560}
        >
          <Input.Search
            allowClear
            placeholder="按地图名称搜索"
            value={mapsSearchKeyword}
            onChange={(event) => setMapsSearchKeyword(event.target.value)}
            style={{ marginBottom: 12 }}
          />
          {mapsLoading ? (
            // Skeleton 取代默认的 spinner，加载体感更平滑
            <div className="metro-maps-skeleton">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} active avatar={false} paragraph={{ rows: 1, width: ['60%'] }} title={{ width: '40%' }} />
              ))}
            </div>
          ) : null}
          <List
            // 自己做了 loading skeleton，AntD 内置 loading 关掉避免双重指示器
            dataSource={savedMaps.filter((item) =>
              mapsSearchKeyword.trim()
                ? item.name.toLowerCase().includes(mapsSearchKeyword.trim().toLowerCase())
                : true
            )}
            locale={{
              emptyText: mapsLoading ? (
                // 加载时把 list 的空态藏起来（skeleton 已经在上方显示）
                <span style={{ display: 'none' }} />
              ) : mapsSearchKeyword.trim() ? (
                <div style={{ padding: '24px 0', color: 'var(--color-text-muted)', fontSize: 13 }}>
                  没有匹配 "{mapsSearchKeyword.trim()}" 的地图
                </div>
              ) : (
                <div className="metro-empty-card metro-empty-card--maps">
                  {/* 一摞叠起来的方案纸 */}
                  <svg
                    className="metro-empty-card__art"
                    width="76"
                    height="62"
                    viewBox="0 0 76 62"
                    aria-hidden="true"
                  >
                    <rect x="14" y="18" width="44" height="34" rx="4" fill="currentColor" opacity="0.16" />
                    <rect x="20" y="12" width="44" height="34" rx="4" fill="currentColor" opacity="0.3" />
                    <rect x="26" y="6" width="44" height="34" rx="4" fill="currentColor" />
                    <circle cx="36" cy="16" r="2.5" fill="#ffffff" />
                    <rect x="42" y="14" width="22" height="3" rx="1.5" fill="#ffffff" opacity="0.85" />
                    <rect x="32" y="24" width="32" height="2" rx="1" fill="#ffffff" opacity="0.55" />
                    <rect x="32" y="30" width="20" height="2" rx="1" fill="#ffffff" opacity="0.55" />
                  </svg>
                  <div className="metro-empty-card__title">暂无已保存方案</div>
                  <div className="metro-empty-card__text">保存当前画布后会出现在这里。</div>
                </div>
              )
            }}
            renderItem={(item) => {
              const isCurrent = currentMap?.id === item.id;
              const counts = [
                { label: '线路', value: item.lineCount },
                { label: '站点', value: item.stationCount },
                { label: '区间', value: item.sectionCount }
              ].filter((c) => typeof c.value === 'number');
              return (
                <List.Item
                  actions={[
                    <Button key="load" type="link" onClick={() => handleLoadMap(item.id)}>
                      加载
                    </Button>,
                    <Button key="rename" type="link" onClick={() => openRenameMapModal(item)}>
                      重命名
                    </Button>,
                    <Button
                      key="duplicate"
                      type="link"
                      loading={duplicatingMapId === item.id}
                      onClick={() => handleDuplicateMap(item.id)}
                    >
                      复制
                    </Button>,
                    <Popconfirm
                      key="delete"
                      title="确认删除该地图？"
                      onConfirm={() => handleDeleteMap(item.id)}
                      okText="删除"
                      cancelText="取消"
                    >
                      <Button type="link" danger>
                        删除
                      </Button>
                    </Popconfirm>
                  ]}
                >
                  <List.Item.Meta
                    title={
                      <Space size={8} wrap>
                        <span>{item.name}</span>
                        {isCurrent ? (
                          <span
                            style={{
                              fontSize: 11,
                              padding: '0 8px',
                              borderRadius: 10,
                              background: 'rgba(37,99,235,0.12)',
                              color: '#2563eb',
                              fontWeight: 600
                            }}
                          >
                            当前
                          </span>
                        ) : null}
                      </Space>
                    }
                    description={
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
                        <span>更新时间：{new Date(item.updatedAt).toLocaleString()}</span>
                        {counts.length ? (
                          <Space size={10} wrap>
                            {counts.map((c) => (
                              <span key={c.label} style={{ color: '#64748b' }}>
                                {c.label}{' '}
                                <strong style={{ color: '#0f172a', fontWeight: 600 }}>{c.value}</strong>
                              </span>
                            ))}
                          </Space>
                        ) : null}
                      </div>
                    }
                  />
                </List.Item>
              );
            }}
          />
        </DraggableModal>

        <DraggableModal
          title="重命名地图"
          open={renameMapModal.visible}
          onOk={handleConfirmRenameMap}
          onCancel={closeRenameMapModal}
          okText="保存"
          cancelText="取消"
          confirmLoading={renameMapModal.saving}
        >
          <Input
            value={renameMapModal.name}
            onChange={(event) => setRenameMapModal((prev) => ({ ...prev, name: event.target.value }))}
            placeholder="请输入新的地图名称"
            maxLength={40}
            onPressEnter={handleConfirmRenameMap}
          />
        </DraggableModal>

        <DraggableModal title={text.settings} open={settingsVisible} onCancel={() => setSettingsVisible(false)} footer={null} width={640}>
          {/* 三个 tab：通用（语言/界面主题）、外观（画布主题/地图样式/城市风格/线名标签）、地图（底图/AMap 样式/站名标签三件套）
              原本一长串纵向 8 段被拆成可见首屏即可全选，不再滚 */}
          <Tabs
            defaultActiveKey="general"
            className="metro-settings-tabs"
            items={[
              {
                key: 'general',
                label: language === 'en-US' ? 'General' : '通用',
                children: (
                  <div className="metro-settings-panel">
                    <section className="metro-settings-section">
                      <div className="metro-settings-label">{text.language}</div>
                      <Radio.Group
                        value={language}
                        onChange={(event) => setLanguage(event.target.value)}
                        optionType="button"
                        buttonStyle="solid"
                      >
                        <Radio.Button value="zh-CN">{text.simplifiedChinese}</Radio.Button>
                        <Radio.Button value="en-US">{text.english}</Radio.Button>
                      </Radio.Group>
                    </section>

                    <section className="metro-settings-section">
                      <div className="metro-settings-label">{text.interfaceTheme}</div>
                      <Radio.Group
                        value={interfaceTheme}
                        onChange={(event) => setInterfaceTheme(event.target.value)}
                        optionType="button"
                        buttonStyle="solid"
                      >
                        <Radio.Button value="light">{text.light}</Radio.Button>
                        <Radio.Button value="dark">{text.dark}</Radio.Button>
                        <Radio.Button value="system">{text.system}</Radio.Button>
                      </Radio.Group>
                    </section>
                  </div>
                )
              },
              {
                key: 'appearance',
                label: language === 'en-US' ? 'Appearance' : '外观',
                children: (
                  <div className="metro-settings-panel">
                    <section className="metro-settings-section">
                      <div className="metro-settings-label">{text.canvasTheme}</div>
                      <Radio.Group
                        value={mapSettings.canvasTheme}
                        onChange={(event) => {
                          pushHistory();
                          setMapSettings((prev) => normalizeMapSettings({ ...prev, canvasTheme: event.target.value }));
                        }}
                        optionType="button"
                        buttonStyle="solid"
                      >
                        <Radio.Button value="light">{text.lightCanvas}</Radio.Button>
                        <Radio.Button value="dark">{text.darkCanvas}</Radio.Button>
                      </Radio.Group>
                    </section>

                    <section className="metro-settings-section">
                      <div className="metro-settings-label">{text.mapStyle}</div>
                      <Radio.Group
                        value={mapSettings.mapStyle}
                        onChange={(event) => {
                          pushHistory();
                          setMapSettings((prev) => normalizeMapSettings({ ...prev, mapStyle: event.target.value }));
                        }}
                        optionType="button"
                        buttonStyle="solid"
                      >
                        <Radio.Button value="classic-badge">{text.classicBadge}</Radio.Button>
                        <Radio.Button value="dot-label">{text.dotLabel}</Radio.Button>
                      </Radio.Group>
                    </section>

                    <section className="metro-settings-section">
                      <div className="metro-settings-label">{text.cityStyle}</div>
                      <Radio.Group
                        value={mapSettings.cityStyle}
                        onChange={(event) => {
                          pushHistory();
                          setMapSettings((prev) => normalizeMapSettings({ ...prev, cityStyle: event.target.value }));
                        }}
                        optionType="button"
                        buttonStyle="solid"
                      >
                        <Radio.Button value="standard">{text.cityStyleStandard}</Radio.Button>
                        <Radio.Button value="beijing">{text.cityStyleBeijing}</Radio.Button>
                        <Radio.Button value="shanghai">{text.cityStyleShanghai}</Radio.Button>
                        <Radio.Button value="mtr">{text.cityStyleMtr}</Radio.Button>
                      </Radio.Group>
                    </section>

                    <section className="metro-settings-section">
                      <div className="metro-settings-label">{text.showLineNameLabels}</div>
                      <Radio.Group
                        value={mapSettings.showLineNameLabels ? 'show' : 'hide'}
                        onChange={(event) => {
                          pushHistory();
                          setMapSettings((prev) =>
                            normalizeMapSettings({ ...prev, showLineNameLabels: event.target.value === 'show' })
                          );
                        }}
                        optionType="button"
                        buttonStyle="solid"
                      >
                        <Radio.Button value="show">{text.lineNameLabelsOn}</Radio.Button>
                        <Radio.Button value="hide">{text.lineNameLabelsOff}</Radio.Button>
                      </Radio.Group>
                    </section>

                    <section className="metro-settings-section">
                      <div className="metro-settings-label">{text.labelDensity}</div>
                      <Radio.Group
                        value={mapSettings.labelDensity}
                        onChange={(event) => {
                          pushHistory();
                          const next = event.target.value as 'paper' | 'adaptive' | 'key';
                          // 同时写入 localStorage，记忆为下一张新方案的默认偏好
                          writeLabelDensity(next);
                          setMapSettings((prev) =>
                            normalizeMapSettings({ ...prev, labelDensity: next })
                          );
                        }}
                        optionType="button"
                        buttonStyle="solid"
                      >
                        <Radio.Button value="paper">{text.labelDensityPaper}</Radio.Button>
                        <Radio.Button value="adaptive">{text.labelDensityAdaptive}</Radio.Button>
                        <Radio.Button value="key">{text.labelDensityKey}</Radio.Button>
                      </Radio.Group>
                    </section>

                    <section className="metro-settings-section">
                      <div className="metro-settings-label">{text.lineCorner}</div>
                      <Radio.Group
                        value={mapSettings.cornerRadius > 0 ? 'round' : 'sharp'}
                        onChange={(event) => {
                          pushHistory();
                          const round = event.target.value === 'round';
                          setMapSettings((prev) =>
                            normalizeMapSettings({
                              ...prev,
                              // 开启时给个默认半径 12；再开沿用上次的值。关闭 = 0。
                              cornerRadius: round ? (prev.cornerRadius > 0 ? prev.cornerRadius : 12) : 0
                            })
                          );
                        }}
                        optionType="button"
                        buttonStyle="solid"
                      >
                        <Radio.Button value="sharp">{text.lineCornerSharp}</Radio.Button>
                        <Radio.Button value="round">{text.lineCornerRound}</Radio.Button>
                      </Radio.Group>
                      {mapSettings.cornerRadius > 0 && (
                        <div className="metro-settings-control" style={{ marginTop: 10 }}>
                          <div className="metro-settings-control__row">
                            <span>{text.lineCornerRadius}</span>
                            <strong>{mapSettings.cornerRadius}px</strong>
                          </div>
                          <Slider
                            min={4}
                            max={40}
                            step={1}
                            value={mapSettings.cornerRadius}
                            onChange={(value) => {
                              beginSettingsInteraction();
                              setMapSettings((prev) => normalizeMapSettings({ ...prev, cornerRadius: value }));
                            }}
                            onChangeComplete={endSettingsInteraction}
                          />
                        </div>
                      )}
                    </section>
                  </div>
                )
              },
              {
                key: 'map',
                label: language === 'en-US' ? 'Map' : '地图',
                children: (
                  <div className="metro-settings-panel">
                    <section className="metro-settings-section">
                      <div className="metro-settings-label">{text.baseMap}</div>
                      <Radio.Group
                        value={mapSettings.baseMap.mode}
                        onChange={(event) => handleBaseMapModeChange(event.target.value)}
                        optionType="button"
                        buttonStyle="solid"
                      >
                        <Radio.Button value="plain">{text.plainCanvas}</Radio.Button>
                        <Radio.Button value="amap">{text.amapBaseMap}</Radio.Button>
                      </Radio.Group>
                    </section>

                    {mapSettings.baseMap.mode === 'amap' && (
                      <section className="metro-settings-section">
                        <div className="metro-settings-label">{text.amapStyle}</div>
                        <Radio.Group
                          value={mapSettings.baseMap.amap?.style || 'normal'}
                          onChange={(event) => {
                            pushHistory();
                            setMapSettings((prev) =>
                              normalizeMapSettings({
                                ...prev,
                                baseMap: {
                                  mode: 'amap',
                                  amap: {
                                    ...(prev.baseMap.amap || DEFAULT_MAP_SETTINGS.baseMap.amap!),
                                    style: event.target.value
                                  }
                                }
                              })
                            );
                          }}
                          optionType="button"
                          buttonStyle="solid"
                        >
                          <Radio.Button value="normal">{text.amapNormal}</Radio.Button>
                          <Radio.Button value="dark">{text.amapDark}</Radio.Button>
                          <Radio.Button value="grey">{text.amapGrey}</Radio.Button>
                          <Radio.Button value="fresh">{text.amapFresh}</Radio.Button>
                        </Radio.Group>
                      </section>
                    )}

                    <section className="metro-settings-section">
                      <div className="metro-settings-label">{text.dotLabelText}</div>
                      <div className="metro-settings-control">
                        <div className="metro-settings-control__row">
                          <span>{text.dotLabelFontSize}</span>
                          <strong>{mapSettings.dotLabelStyle.fontSize}px</strong>
                        </div>
                        <Slider
                          min={10}
                          max={24}
                          step={1}
                          value={mapSettings.dotLabelStyle.fontSize}
                          onChange={(value) => {
                            beginSettingsInteraction();
                            setMapSettings((prev) =>
                              normalizeMapSettings({
                                ...prev,
                                dotLabelStyle: { ...prev.dotLabelStyle, fontSize: value }
                              })
                            );
                          }}
                          onChangeComplete={endSettingsInteraction}
                        />
                      </div>
                      <div className="metro-settings-control">
                        <div className="metro-settings-control__row">
                          <span>{text.dotLabelFontWeight}</span>
                          <strong>{mapSettings.dotLabelStyle.fontWeight}</strong>
                        </div>
                        <Slider
                          min={300}
                          max={900}
                          step={10}
                          value={mapSettings.dotLabelStyle.fontWeight}
                          onChange={(value) => {
                            beginSettingsInteraction();
                            setMapSettings((prev) =>
                              normalizeMapSettings({
                                ...prev,
                                dotLabelStyle: { ...prev.dotLabelStyle, fontWeight: value }
                              })
                            );
                          }}
                          onChangeComplete={endSettingsInteraction}
                        />
                      </div>
                      <div className="metro-settings-color-row">
                        <span>{text.dotLabelColor}</span>
                        <ColorPicker
                          value={mapSettings.dotLabelStyle.color}
                          onChange={(color) => {
                            beginSettingsInteraction();
                            setMapSettings((prev) =>
                              normalizeMapSettings({
                                ...prev,
                                dotLabelStyle: {
                                  ...prev.dotLabelStyle,
                                  color: color.toHexString()
                                }
                              })
                            );
                          }}
                          onChangeComplete={endSettingsInteraction}
                          showText
                        />
                      </div>
                      <div className="metro-settings-reset-row">
                        <Button
                          size="small"
                          onClick={() => {
                            pushHistory();
                            setMapSettings((prev) =>
                              normalizeMapSettings({
                                ...prev,
                                dotLabelStyle: DEFAULT_MAP_SETTINGS.dotLabelStyle
                              })
                            );
                          }}
                        >
                          {text.resetDefault}
                        </Button>
                      </div>
                    </section>
                  </div>
                )
              }
            ]}
          />
          <div className="metro-settings-footer">
            <Button onClick={() => setSettingsVisible(false)}>{text.close}</Button>
          </div>
        </DraggableModal>

        <DraggableModal
          title={text.profile}
          open={profileVisible}
          onCancel={() => setProfileVisible(false)}
          footer={null}
          width={460}
        >
          <input
            ref={avatarInputRef}
            type="file"
            accept="image/*"
            onChange={handleProfileAvatarUpload}
            style={{ display: 'none' }}
          />

          {/* 顶部身份卡：大头像 + 名字 + 邮箱（legacy 兜底手机号）+ 单独的"更换头像"按钮。
              头像也可以点击直接触发上传，提供两种入口 */}
          <div className="metro-profile-identity">
            <Avatar
              size={64}
              src={userProfile.avatar}
              className="metro-profile-identity__avatar"
              onClick={() => avatarInputRef.current?.click()}
            >
              {userProfile.avatar ? null : displayInitial}
            </Avatar>
            <div className="metro-profile-identity__main">
              <div className="metro-profile-identity__name">{displayName}</div>
              <div className="metro-profile-identity__phone">
                {userProfile.email || (userProfile.phone ? `+86 ${userProfile.phone}` : '')}
              </div>
              <button
                type="button"
                className="metro-profile-identity__change"
                onClick={() => avatarInputRef.current?.click()}
              >
                <EditOutlined /> {text.profileChangeAvatar}
              </button>
            </div>
          </div>

          <Form
            layout="vertical"
            autoComplete="off"
            initialValues={{
              username: userProfile.username,
              password: '',
              confirm: ''
            }}
            onFinish={handleUpdateProfile}
            className="metro-profile-form"
          >
            {/* 账号信息分组 */}
            <div className="metro-profile-section">
              <div className="metro-profile-section__title">{text.profileAccountSection}</div>
              <Form.Item
                label={text.profileUsername}
                name="username"
                rules={[{ required: true, message: '请输入用户名' }]}
              >
                <Input placeholder={text.profileUsernamePlaceholder} maxLength={16} />
              </Form.Item>

              {/* 邮箱：主标识，只读。带"已验证 / 未验证"badge。
                  legacy 用户没邮箱时这里展示手机号 + 提示去补邮箱（升级流程已在登录处理）。 */}
              {userProfile.email ? (
                <div className="metro-profile-field">
                  <div className="metro-profile-field__label">{text.email}</div>
                  <div className="metro-profile-field__value">
                    <span>{userProfile.email}</span>
                    <span
                      className="metro-profile-field__badge"
                      style={userProfile.emailVerified ? undefined : { color: 'var(--color-warning, #d97706)' }}
                    >
                      <span className="metro-profile-field__badge-dot" />
                      {userProfile.emailVerified ? text.emailVerified : text.emailUnverified}
                    </span>
                  </div>
                </div>
              ) : userProfile.phone ? (
                <div className="metro-profile-field">
                  <div className="metro-profile-field__label">{text.phone}</div>
                  <div className="metro-profile-field__value">
                    <span>+86 {userProfile.phone}</span>
                    <span className="metro-profile-field__badge">
                      <span className="metro-profile-field__badge-dot" />
                      {text.profilePhoneBound}
                    </span>
                  </div>
                </div>
              ) : null}
            </div>

            {/* 修改密码分组 */}
            <div className="metro-profile-section">
              <div className="metro-profile-section__title">{text.profilePasswordSection}</div>
              <Form.Item
                label={text.profileNewPassword}
                name="password"
                rules={[{ min: 6, message: text.profilePasswordMin }]}
              >
                <Input.Password
                  placeholder={text.profileNewPasswordPlaceholder}
                  autoComplete="new-password"
                />
              </Form.Item>
              <Form.Item
                label={text.profileConfirmPassword}
                name="confirm"
                dependencies={['password']}
                rules={[
                  ({ getFieldValue }) => ({
                    validator(_, value) {
                      const password = getFieldValue('password');
                      if (!password && !value) {
                        return Promise.resolve();
                      }
                      if (password && !value) {
                        return Promise.reject(new Error(text.profilePasswordRequiredConfirm));
                      }
                      if (password === value) {
                        return Promise.resolve();
                      }
                      return Promise.reject(new Error(text.profilePasswordMismatch));
                    }
                  })
                ]}
              >
                <Input.Password
                  placeholder={text.profileConfirmPasswordPlaceholder}
                  autoComplete="new-password"
                />
              </Form.Item>
            </div>

            <div className="metro-profile-actions">
              <Button onClick={() => setProfileVisible(false)}>{text.profileCancel}</Button>
              <Button type="primary" htmlType="submit">
                {text.profileSave}
              </Button>
            </div>
          </Form>
        </DraggableModal>

        <DraggableModal open={isExporting} footer={null} closable={false} centered>
          正在导出动态视频，请稍候…
        </DraggableModal>
      </Layout>
    </div>
      </AntdApp>
    </ConfigProvider>
  );
};

export default App;
