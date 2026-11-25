import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Avatar, Button, ColorPicker, ConfigProvider, Divider, Dropdown, Form, Input, Layout, List, Modal, Popconfirm, Progress, Skeleton, Slider, Space, Tabs, Tooltip, App as AntdApp, message, theme as antdTheme } from 'antd';
import {
  CheckOutlined,
  DownOutlined,
  FileAddOutlined,
  FolderOpenOutlined,
  UserOutlined,
  SettingOutlined,
  LogoutOutlined,
  EditOutlined,
  MenuOutlined,
  SaveOutlined,
  DownloadOutlined,
  InfoCircleOutlined,
  ThunderboltOutlined,
  AppstoreOutlined,
  MoreOutlined,
  PlaySquareOutlined
} from '@ant-design/icons';
import {
  api,
  bootstrapAuthSession,
  clearAuthSession,
  getToken,
  saveAuthSession,
  touchAuthActivity,
  touchAuthSessionUser,
  AIOperation
} from './api';
import { createId } from './utils/id';
import AuthPanel from './components/AuthPanel';
import { GuestDraft, createGuestDraft, readGuestDraft, writeGuestDraft, deleteGuestDraft, hasGuestSession, setGuestSession } from './lib/guestDraft';
import GuestAnimationPreview from './components/GuestAnimationPreview';
import Canvas from './components/Canvas';
import GalleryPage from './gallery/GalleryPage';
import PrivateMapThumbnail from './gallery/PrivateMapThumbnail';
import PublishDialog from './gallery/PublishDialog';
import { gallery, Work } from './gallery/api';
import './gallery/gallery.css';
import DraggableModal from './components/DraggableModal';
import ElasticCapsuleTabs from './components/ElasticCapsuleTabs';
import Sidebar from './components/Sidebar';
import Toolbar from './components/Toolbar';
import VideoExportModal, { VideoExportConfig } from './components/VideoExportModal';
import AIAssistantModal from './components/AIAssistantModal';
import AIApiSettingsModal from './components/AIApiSettingsModal';
import {
  AI_CONFIG_CHANGED_EVENT,
  getActiveAiBadgeLabel,
  hasActiveCustomAiKey
} from './lib/aiCustomConfig';
import { migrateLegacyGcj02MapToWgs84 } from './lib/coordTransform';
import { migrateDraftAISessions } from './lib/aiSessionStore';
import {
  AmapStyle,
  BaseMapMode,
  DEFAULT_MAP_SETTINGS,
  LightCityArchetype,
  Line,
  MapSettings,
  Section,
  Station,
  normalizeMapSettings,
  normalizeSections
} from './types';
import { generateLightCity } from './lib/lightCity';
import { LightCityPickerModal } from './components/LightCityPanel';
import BaseMapPicker from './components/BaseMapPicker';
import AboutPanel from './components/AboutPanel';
import { exportVideoFromStage } from './lib/exportVideo';
import { VideoExportProgress } from './lib/recordVideo';
import {
  deleteStationFromGraph,
  MapGraph,
  reconcileGraph,
  removeStationFromLine,
  reorderLineStations
} from './lib/graphOps';
import { buildMetroSvg } from './lib/exportSvg';
import { DocumentSession } from './lib/documentSession';
import { interpretCommand, ResolvedCommand, AppAction } from './lib/commandParser';
import CommandBar from './components/CommandBar';
import { isAndroidClient, isAndroidDevice, saveAndroidExport } from './lib/androidClient';
import {
  DesktopMenuCommand,
  hasDesktopBridge,
  isDesktopClient,
  saveDesktopExport
} from './lib/desktopClient';
import {
  MetroProjectData,
  parseMetroProjectJson,
  sanitizeProjectFilename,
  serializeMetroProject,
  stripProjectExtension
} from './lib/projectFile';
import { compressImageDataUrl } from './utils/imageCompress';

// 头像 dataURL 体积阈值：超过即认为是"需要压缩的大头像"。
// 后端 PUT /api/me 给的硬上限是 200_000；这里取 60KB 作为"还能再瘦一点"的软阈值。
const AVATAR_COMPRESS_THRESHOLD = 60_000;

const isAuthCallbackURL = () => /^\/(verify-email|reset-password)/.test(window.location.pathname) &&
  !!new URLSearchParams(window.location.search).get('token');
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
    ...(doc.mapSettings.videoExport ? { videoExport: {
      ...doc.mapSettings.videoExport,
      segments: doc.mapSettings.videoExport.segments.map(segment => ({ ...segment }))
    } } : {}),
    dotLabelStyle: { ...doc.mapSettings.dotLabelStyle },
    baseMap: {
      ...doc.mapSettings.baseMap,
      amap: doc.mapSettings.baseMap.amap
        ? {
            ...doc.mapSettings.baseMap.amap,
            center: [doc.mapSettings.baseMap.amap.center[0], doc.mapSettings.baseMap.amap.center[1]]
          }
        : undefined,
      lightCity: doc.mapSettings.baseMap.lightCity
        ? {
            ...doc.mapSettings.baseMap.lightCity,
            layerVisibility: { ...doc.mapSettings.baseMap.lightCity.layerVisibility },
            features: doc.mapSettings.baseMap.lightCity.features.map(f =>
              f.type === 'label'
                ? { ...f }
                : { ...f, points: f.points.map(p => ({ ...p })) }
            )
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
    saveMap: '保存',
    savedState: '已保存',
    overwriteSave: '保存',
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
    lightCityBaseMap: '轻城市',
    amapBaseMap: '地理底图',
    amapStyle: '底图风格',
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
    waypointVisibility: '默认隐藏途经点',
    waypointShow: '显示控制柄',
    waypointHide: '默认隐藏',
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
    saveMap: 'Save',
    savedState: 'Saved',
    overwriteSave: 'Save',
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
    lightCityBaseMap: 'Light city',
    amapBaseMap: 'City basemap',
    amapStyle: 'Basemap style',
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
    waypointVisibility: 'Hide waypoints by default',
    waypointShow: 'Show handles',
    waypointHide: 'Hide by default',
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

const HIDE_WAYPOINTS_KEY = 'metro_hide_waypoints';
const readHideWaypoints = (): boolean => {
  try {
    return localStorage.getItem(HIDE_WAYPOINTS_KEY) === '1';
  } catch {
    return false;
  }
};
const writeHideWaypoints = (hide: boolean) => {
  try {
    localStorage.setItem(HIDE_WAYPOINTS_KEY, hide ? '1' : '0');
  } catch {
    /* ignore */
  }
};

const App: React.FC = () => {
  const [publicPath, setPublicPath] = useState(() => window.location.pathname + window.location.search);
  const publicRoute = /^\/(gallery|works)(\/|\?|$)/.test(publicPath);
  const gallerySourceRef = useRef<string>();
  const [publishSource, setPublishSource] = useState<{id:string;name:string;work?:Work}|null>(null);
  const [myPublications, setMyPublications] = useState<Work[]>([]);
  const [mapsPublicationFilter,setMapsPublicationFilter] = useState("all");
  useEffect(() => {
    const update = () => setPublicPath(window.location.pathname + window.location.search);
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);
  const navigatePublic = (path: string) => {window.history.pushState({}, '', path);setPublicPath(path);};

  const [initialBootState] = useState(() => {
    if (isAuthCallbackURL()) {
      return {
        userProfile: null as UserProfile | null,
        authBooting: false,
        previewMode: false,
        hasLastMap: false,
        cleanWorkbenchQuery: false
      };
    }
    const auth = bootstrapAuthSession();
    const hasActiveAuth = auth.status === 'active' || auth.status === 'verifying';
    const params = new URLSearchParams(window.location.search);
    const previewParam = params.get('preview') === '1';
    const workbenchParam = params.get('workbench') === '1';
    const guestActive = hasGuestSession();
    // 7 天内活跃登录态下，点「返回工作台」(?workbench=1) 直接进入云端工作台；
    // 未登录或已超时状态下，?workbench=1 / ?preview=1 / 已有访客草稿会话均直接进入免登录预览工作台。
    const nextPreviewMode = hasActiveAuth
      ? (previewParam || guestActive)
      : (previewParam || workbenchParam || guestActive);

    let lastMapId: string | null = null;
    try { lastMapId = localStorage.getItem(LAST_MAP_KEY); } catch { /* ignore */ }
    const shouldAutoLoadCloudMap = hasActiveAuth && Boolean(lastMapId) && !nextPreviewMode;

    return {
      userProfile: auth.user ? { ...auth.user, avatar: auth.user.avatar || undefined, password: '' } : null,
      authBooting: auth.status === 'verifying',
      previewMode: nextPreviewMode,
      hasLastMap: shouldAutoLoadCloudMap,
      cleanWorkbenchQuery: hasActiveAuth && workbenchParam && !previewParam
    };
  });

  const [lines, setLines] = useState<Line[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [stations, setStations] = useState<Station[]>([]);
  const [currentLineId, setCurrentLineId] = useState<string | null>(null);
  const [isMapOpening, setIsMapOpening] = useState<boolean>(initialBootState.hasLastMap);
  const mapOpeningRequestRef = useRef(0);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(initialBootState.userProfile);
  const [authBooting, setAuthBooting] = useState<boolean>(initialBootState.authBooting);
  const [previewMode, setPreviewMode] = useState<boolean>(initialBootState.previewMode);
  const [guestReady, setGuestReady] = useState(false);
  const [guestDraftId, setGuestDraftId] = useState<string | null>(null);
  const guestDraftIdRef = useRef<string | null>(null);
  const guestSavedRevisionRef = useRef<number | null>(null);
  const [guestStorageError, setGuestStorageError] = useState(false);
  const guestReadFailedRef = useRef(false);
  const [guestAnimationOpen, setGuestAnimationOpen] = useState(false);
  const [guestInitialViewport, setGuestInitialViewport] = useState<GuestDraft['viewport']>();
  const [guestViewport, setGuestViewport] = useState<GuestDraft['viewport']>();
  const [authVisible, setAuthVisible] = useState(false);
  const [authAction, setAuthAction] = useState<'save' | 'maps' | 'ai' | 'video' | 'profile' | null>(null);
  const guestBootRef = useRef(false);
  const guestPreviewRequestedRef = useRef(previewMode || hasGuestSession());
  const guestRestorePromiseRef = useRef<Promise<void> | null>(null);
  const requestGuestAuth = (action: typeof authAction) => {
    setAuthAction(action);
    setAuthVisible(true);
  };
  const [profileVisible, setProfileVisible] = useState(false);
  const [saveMapVisible, setSaveMapVisible] = useState(false);
  const [mapsVisible, setMapsVisible] = useState(false);
  const [mapsLoading, setMapsLoading] = useState(false);
  const [saveMapSaving, setSaveMapSaving] = useState(false);
  const saveMapInFlightRef = useRef(false);
  const [videoModalOpen, setVideoModalOpen] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [videoProgress, setVideoProgress] = useState<VideoExportProgress>({ phase: 'preparing', percent: 0, elapsedSec: 0, totalSec: 0 });
  const [exportedVideo, setExportedVideo] = useState<{ url: string; filename: string; format: string } | null>(null);
  const exportedVideoUrlRef = useRef<string | null>(null);
  const closeExportedVideoPreview = () => {
    if (exportedVideoUrlRef.current) {
      URL.revokeObjectURL(exportedVideoUrlRef.current);
      exportedVideoUrlRef.current = null;
    }
    setExportedVideo(null);
  };
  const videoAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => {
    videoAbortRef.current?.abort();
    if (exportedVideoUrlRef.current) {
      URL.revokeObjectURL(exportedVideoUrlRef.current);
      exportedVideoUrlRef.current = null;
    }
  }, []);
  // 移动端侧栏抽屉开关。桌面端 CSS 直接展示 Sider，这个 state 只在 ≤768px 起作用。
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
  const [mobileViewControlsHost, setMobileViewControlsHost] = useState<HTMLDivElement | null>(null);
  const [createLineRequest, setCreateLineRequest] = useState(0);
  // AI 助手对话框与本地自有密钥设置
  const [aiModalOpen, setAiModalOpen] = useState(false);
  const [aiApiSettingsOpen, setAiApiSettingsOpen] = useState(false);
  const [customAiBadge, setCustomAiBadge] = useState<string | null>(() => getActiveAiBadgeLabel());
  useEffect(() => {
    const syncAiCfg = () => setCustomAiBadge(getActiveAiBadgeLabel());
    window.addEventListener(AI_CONFIG_CHANGED_EVENT, syncAiCfg);
    return () => window.removeEventListener(AI_CONFIG_CHANGED_EVENT, syncAiCfg);
  }, []);
  const [aiBusy, setAiBusy] = useState(false);
  const [mapName, setMapName] = useState('');
  const [savedMaps, setSavedMaps] = useState<MapSummaryState[]>([]);
  const [currentMap, setCurrentMap] = useState<MapSummaryState | null>(null);
  const currentMapRef = useRef(currentMap);
  useLayoutEffect(() => { currentMapRef.current = currentMap; }, [currentMap]);
  const [localProject, setLocalProject] = useState<{ id: string; name: string; filePath: string | null } | null>(null);
  const localProjectRef = useRef(localProject);
  useLayoutEffect(() => { localProjectRef.current = localProject; }, [localProject]);
  const launchProjectClaimedRef = useRef(false);
  const localFileInputRef = useRef<HTMLInputElement | null>(null);
  const [isOnline, setIsOnline] = useState<boolean>(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine !== false
  );
  useEffect(() => {
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);
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
  const [aboutVisible, setAboutVisible] = useState(false);
  const [baseMapPickerStyle, setBaseMapPickerStyle] = useState<AmapStyle | null>(null);
  const [lightCityPickerOpen, setLightCityPickerOpen] = useState(false);
  const [openTerrainSculptSeq, setOpenTerrainSculptSeq] = useState(0);
  const [language, setLanguage] = useState<AppLanguage>(getInitialLanguage);
  const [interfaceTheme, setInterfaceTheme] = useState<InterfaceTheme>(getInitialInterfaceTheme);
  const [systemTheme, setSystemTheme] = useState<'light' | 'dark'>(getSystemTheme);
  const [mapSettings, setMapSettings] = useState<MapSettings>(() => ({
    ...DEFAULT_MAP_SETTINGS,
    labelDensity: readLabelDensity(),
    hideWaypoints: readHideWaypoints()
  }));
  const [past, setPast] = useState<DocSnapshot[]>([]);
  const [future, setFuture] = useState<DocSnapshot[]>([]);
  const isApplyingHistoryRef = useRef(false);
  // 「有未保存修改」标记。任何编辑（pushHistory / undo / redo）置 true；
  // 保存成功、加载 / 新建 / 删除当前方案（resetHistory）置 false。
  // dirtyRef 给 beforeunload 监听器读最新值用，避免重复挂载监听。
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const documentSessionRef = useRef(new DocumentSession());
  const skipNextDocumentChangeRef = useRef(false);
  const markDirty = useCallback(() => {
    documentSessionRef.current.edit();
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
      if (guestDraftIdRef.current && guestSavedRevisionRef.current === documentSessionRef.current.capture().revision) return;
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
  useLayoutEffect(() => {
    // Slider 连续修改只压一次历史，也必须识别保存期间的后续修改。
    if (linesRef.current !== lines || sectionsRef.current !== sections ||
      stationsRef.current !== stations || mapSettingsRef.current !== mapSettings) {
      documentSessionRef.current.edit();
      if (!skipNextDocumentChangeRef.current && !dirtyRef.current) {
        dirtyRef.current = true;
        setDirty(true);
      }
    }
    skipNextDocumentChangeRef.current = false;
    linesRef.current = lines;
    sectionsRef.current = sections;
    stationsRef.current = stations;
    mapSettingsRef.current = mapSettings;
  }, [lines, sections, stations, mapSettings]);
  // 命令行：当前线路 ref（给命令上下文取最新值）；命令栏输入 ref（/ 聚焦）；视图命令通道
  const currentLineIdRef = useRef<string | null>(currentLineId);
  useLayoutEffect(() => { currentLineIdRef.current = currentLineId; }, [currentLineId]);
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
    documentSessionRef.current.reset();
    skipNextDocumentChangeRef.current = true;
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
    const requestToken = getToken();
    setMapsLoading(true);
    try {
      const { maps } = await api.listMaps();
      if (getToken() === requestToken) setSavedMaps(maps);
    } catch (error: any) {
      if (showError && getToken() === requestToken) {
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
    if (initialBootState.cleanWorkbenchQuery && !/^\/(gallery|works)(\/|$)/.test(window.location.pathname)) {
      window.history.replaceState({}, '', '/');
    }
  }, [initialBootState.cleanWorkbenchQuery]);

  useEffect(() => {
    const syncAuthActivity = () => {
      if (document.visibilityState === 'visible') {
        touchAuthActivity();
      }
    };
    document.addEventListener('visibilitychange', syncAuthActivity);
    return () => document.removeEventListener('visibilitychange', syncAuthActivity);
  }, []);

  useEffect(() => {
    const boot = async () => {
      if (isAuthCallbackURL()) {
        setAuthBooting(false);
        setIsMapOpening(false);
        return;
      }
      const token = getToken();
      if (!token) {
        setAuthBooting(false);
        setIsMapOpening(false);
        return;
      }
      const restoreTicket = documentSessionRef.current.beginLoad();
      try {
        const { user, token: refreshedToken } = await api.me();
        if (getToken() !== token) {
          if (mapOpeningRequestRef.current === 0) setIsMapOpening(false);
          return;
        }
        const activeToken = refreshedToken || token;
        touchAuthSessionUser(user, activeToken);
        setUserProfile({ ...user, avatar: user.avatar || undefined, password: '' });
        setAuthBooting(false);
        refreshSavedMaps(false);
        // 自动恢复上次编辑的方案。任何一步失败就清掉指针并保持空白工作台。
        let lastMapId: string | null = null;
        try { lastMapId = localStorage.getItem(LAST_MAP_KEY); } catch { /* ignore */ }
        if (lastMapId && !launchProjectClaimedRef.current && !guestPreviewRequestedRef.current && !hasGuestSession()) {
          const openingRequest = ++mapOpeningRequestRef.current;
          setIsMapOpening(true);
          try {
            const { map } = await api.getMap(lastMapId);
            if (getToken() === activeToken && documentSessionRef.current.canApplyLoad(restoreTicket)) applyLoadedMap(map);
          } catch {
            if (getToken() === activeToken && documentSessionRef.current.isLatestLoad(restoreTicket)) {
              try { localStorage.removeItem(LAST_MAP_KEY); } catch { /* ignore */ }
            }
          } finally {
            if (mapOpeningRequestRef.current === openingRequest) setIsMapOpening(false);
          }
        } else if (mapOpeningRequestRef.current === 0) {
          setIsMapOpening(false);
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
              if (getToken() === activeToken) {
                touchAuthSessionUser(migrated);
                setUserProfile({ ...migrated, avatar: migrated.avatar || undefined, password: '' });
              }
            }
          } catch (e) {
            console.warn('avatar migration skipped', e);
          }
        }
      } catch (error: any) {
        // 仅当服务端明确返回 401/404（凭证失效或账号不存在）时才清除登录态；
        // 偶发网络波动或后端冷启动保留 7 天有效期内的本地会话，避免把已登录用户误踢回登录页。
        if (getToken() === token && (error?.status === 401 || error?.status === 404)) {
          clearAuthSession();
          setUserProfile(null);
        }
        if (mapOpeningRequestRef.current === 0) {
          setIsMapOpening(false);
        }
      } finally {
        setAuthBooting(false);
      }
    };
    boot();
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (/^\/(gallery|works)(\/|$)/.test(window.location.pathname)) return;
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

  const handleAddLine = useCallback((name: string, color: string) => {
    if (linesRef.current.some((line) => line.color === color)) {
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
  }, [pushHistory]);

  const handleDeselectLine = useCallback(() => {
    setCurrentLineId(null);
  }, []);

  const handleSidebarSelectLine = useCallback((id: string) => {
    setCurrentLineId(id);
    setIsMobileSidebarOpen(false);
  }, []);

  const handleSidebarAddLine = useCallback((name: string, color: string) => {
    const ok = handleAddLine(name, color);
    if (ok) setIsMobileSidebarOpen(false);
    return ok;
  }, [handleAddLine]);

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

  const commitGraphState = useCallback((next: MapGraph) => {
    linesRef.current = next.lines;
    stationsRef.current = next.stations;
    sectionsRef.current = next.sections;
    setLines(next.lines);
    setStations(next.stations);
    setSections(next.sections);
  }, []);

  const handleApplyGraphTransaction = useCallback(
    (
      updater: (current: MapGraph) => MapGraph,
      options?: { recordHistory?: boolean; selectLineId?: string | null }
    ) => {
      if (options?.recordHistory !== false) {
        pushHistory();
      }
      const baseGraph: MapGraph = {
        lines: linesRef.current,
        stations: stationsRef.current,
        sections: sectionsRef.current
      };
      const next = reconcileGraph(updater(baseGraph));
      commitGraphState(next);
      if (options && 'selectLineId' in options) {
        currentLineIdRef.current = options.selectLineId ?? null;
        setCurrentLineId(options.selectLineId ?? null);
      }
    },
    [commitGraphState, pushHistory]
  );

  const handleRemoveStationFromLine = useCallback((lineId: string, stationId: string) => {
    pushHistory();
    const next = removeStationFromLine(
      { lines: linesRef.current, stations: stationsRef.current, sections: sectionsRef.current },
      lineId,
      stationId
    );
    commitGraphState(next);
  }, [commitGraphState, pushHistory]);

  const handleReorderStations = useCallback((lineId: string, stationIds: string[]) => {
    pushHistory();
    const next = reorderLineStations(
      { lines: linesRef.current, stations: stationsRef.current, sections: sectionsRef.current },
      lineId,
      stationIds
    );
    commitGraphState(next);
  }, [commitGraphState, pushHistory]);

  const handleDeleteLine = useCallback((lineId: string) => {
    pushHistory();
    const deletingLine = linesRef.current.find((line) => line.id === lineId);
    if (deletingLine) {
      const deletingSectionSet = new Set(deletingLine.sectionIds);
      setSections((prev) => prev.filter((section) => !deletingSectionSet.has(section.id)));
    }

    setLines((prev) => prev.filter((line) => line.id !== lineId));
    if (currentLineIdRef.current === lineId) {
      setCurrentLineId(null);
    }
    message.success('线路已删除');
  }, [pushHistory]);

  const handleChangeLineColor = useCallback((lineId: string, newColor: string) => {
    if (linesRef.current.some((line) => line.id !== lineId && line.color === newColor)) {
      message.error('该颜色已被其他线路占用，请选择其他颜色');
      return false;
    }

    pushHistory();
    setLines((prev) => prev.map((line) => (line.id === lineId ? { ...line, color: newColor } : line)));
    message.success('线路颜色已更新');
    return true;
  }, [pushHistory]);

  const handleChangeLineName = useCallback((lineId: string, newName: string) => {
    pushHistory();
    setLines((prev) => prev.map((line) => (line.id === lineId ? { ...line, name: newName } : line)));
    message.success('线路名称已更新');
  }, [pushHistory]);

  const handleDeleteStation = (stationId: string) => {
    pushHistory();
    // 删中间站时会自动用一条新区间缝合前后邻站，避免线路断成两截（见 graphOps）
    const next = deleteStationFromGraph(stationId, {
      lines: linesRef.current,
      stations: stationsRef.current,
      sections: sectionsRef.current
    });
    commitGraphState(next);
    message.success('站点已删除');
  };

  const handleDeleteSection = (sectionId: string) => {
    const target = sectionsRef.current.find((section) => section.id === sectionId);
    if (!target) return;

    pushHistory();
    const next = reconcileGraph({
      lines: linesRef.current.map((line) =>
        line.id !== target.lineId
          ? line
          : { ...line, sectionIds: line.sectionIds.filter((id) => id !== sectionId) }
      ),
      stations: stationsRef.current,
      sections: sectionsRef.current.filter((section) => section.id !== sectionId)
    });
    commitGraphState(next);
    message.success('区间已删除');
  };

  const handleReorderLines = useCallback((newOrder: string[]) => {
    pushHistory();
    const lineMap = new Map(linesRef.current.map((line) => [line.id, line]));
    const nextLines = newOrder.map((lineId) => lineMap.get(lineId)).filter(Boolean) as Line[];
    setLines(nextLines);
    message.success('线路顺序已更新');
  }, [pushHistory]);

  const applyGuestDraft = (draft: GuestDraft) => {
    gallerySourceRef.current = draft.gallerySourceToken;
    guestDraftIdRef.current = draft.id;
    guestSavedRevisionRef.current = null;
    setGuestDraftId(draft.id);
    const migrated = migrateLegacyGcj02MapToWgs84({
      stations: draft.stations,
      sections: draft.sections,
      mapSettings: draft.mapSettings
    });
    const healed = reconcileGraph({
      lines: draft.lines,
      stations: migrated.stations,
      sections: migrated.sections
    });
    commitGraphState(healed);
    setMapSettings(migrated.mapSettings);
    setCurrentLineId(draft.currentLineId);
    setMapName(draft.name);
    setGuestInitialViewport(draft.viewport);
    setGuestViewport(draft.viewport);
    setCurrentMap(null);
    resetHistory();
    setGuestReady(true);
  };

  const startGuestPreview = async () => {
    guestPreviewRequestedRef.current = true;
    setGuestSession(true);
    if (!isAuthCallbackURL()) {
      setPreviewMode(true);
      const params = new URLSearchParams(window.location.search);
      params.set('preview', '1');
      if (!/^\/(gallery|works)(\/|$)/.test(window.location.pathname)) window.history.replaceState({}, '', `/?${params}`);
    }
    if (guestDraftIdRef.current) { setGuestReady(true); return; }
    try {
      const stored = await readGuestDraft();
      const draft = stored || createGuestDraft();
      applyGuestDraft(draft);
    } catch (error) {
      guestReadFailedRef.current = true;
      // Retain a readable in-memory document if storage is unavailable; offer a backup.
      if (!guestDraftIdRef.current) applyGuestDraft(createGuestDraft());
      setGuestStorageError(true);
    }
  };

  const startGuestPreviewRef = useRef(startGuestPreview);
  startGuestPreviewRef.current = startGuestPreview;
  useEffect(() => {
    if (guestPreviewRequestedRef.current && !guestBootRef.current) {
      guestBootRef.current = true;
      guestRestorePromiseRef.current = startGuestPreviewRef.current();
    }
  }, []);

  const draftSnapshotRef = useRef<GuestDraft | null>(null);
  useLayoutEffect(() => {
    draftSnapshotRef.current = guestDraftId ? {
      version: 1, id: guestDraftId, updatedAt: Date.now(), name: mapName, gallerySourceToken: gallerySourceRef.current,
      lines, stations, sections, mapSettings, currentLineId, viewport: guestViewport
    } : null;
  }, [guestDraftId, lines, stations, sections, mapSettings, currentLineId, mapName, guestViewport]);

  const persistGuestDraft = useCallback(async () => {
    const snapshot = draftSnapshotRef.current;
    if (!snapshot || snapshot.id !== guestDraftIdRef.current || guestReadFailedRef.current) return;
    try {
      const ticket = documentSessionRef.current.capture();
      await writeGuestDraft(snapshot);
      if (snapshot.id !== guestDraftIdRef.current) return;
      guestSavedRevisionRef.current = ticket.revision;
      setGuestStorageError(false);
    } catch {
      setGuestStorageError(true);
    }
  }, []);
  useEffect(() => {
    if (!guestDraftId || !guestReady || guestReadFailedRef.current) return;
    const timer = window.setTimeout(() => { void persistGuestDraft(); }, 250);
    return () => window.clearTimeout(timer);
  }, [guestDraftId, guestReady, lines, stations, sections, mapSettings, currentLineId, mapName, guestViewport, persistGuestDraft]);
  useEffect(() => {
    const persist = () => { if (document.visibilityState === 'hidden') void persistGuestDraft(); };
    document.addEventListener('visibilitychange', persist);
    window.addEventListener('pagehide', persistGuestDraft);
    return () => {
      document.removeEventListener('visibilitychange', persist);
      window.removeEventListener('pagehide', persistGuestDraft);
    };
  }, [persistGuestDraft]);

  const retryGuestStorage = async () => {
    if (guestReadFailedRef.current) {
      try {
        const stored = await readGuestDraft();
        if (stored) {
          Modal.confirm({ title: '恢复已保存的草稿？', content: '已重新读到本机草稿。恢复后将显示上次保存的版本；你也可以先下载当前画布备份。',
            okText: '恢复草稿', cancelText: '保留当前画布', onOk: () => {
              guestReadFailedRef.current = false;
              setGuestStorageError(false);
              applyGuestDraft(stored);
            } });
          return;
        }
        guestReadFailedRef.current = false;
      } catch { message.error('本机存储仍未恢复，请先下载备份'); return; }
    }
    await persistGuestDraft();
  };

  const downloadGuestBackup = async () => {
    if (!draftSnapshotRef.current) return;
    const blob = new Blob([JSON.stringify(draftSnapshotRef.current, null, 2)], { type: 'application/json' });
    const filename = 'metro-designer-草稿备份.json';
    if (isAndroidClient) { await saveAndroidExport(blob, filename); return; }
    if (hasDesktopBridge()) {
      const saved = await saveDesktopExport(blob, filename);
      if (saved) message.success('草稿备份已保存');
      return;
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = filename;
    link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  // AuthPanel 走完整的登录 / 注册 / 验证 / 重置流程后，统一通过 onAuthenticated 回调
  // 交付 { token, user } —— 我们只关心持久化和切到工作台。
  const handleAuthenticated = async ({ token, user }: { token: string; user: UserProfile }) => {
    await guestRestorePromiseRef.current;
    saveAuthSession(token, user);
    setAuthBooting(false);
    setUserProfile({ ...user, avatar: user.avatar || undefined, password: '' });
    setAuthVisible(false);
    refreshSavedMaps(false);
    let lastMapId: string | null = null;
    try { lastMapId = localStorage.getItem(LAST_MAP_KEY); } catch { /* ignore */ }
    if (
      lastMapId &&
      !guestDraftIdRef.current &&
      linesRef.current.length === 0 &&
      stationsRef.current.length === 0 &&
      sectionsRef.current.length === 0
    ) {
      const restoreTicket = documentSessionRef.current.beginLoad();
      const openingRequest = ++mapOpeningRequestRef.current;
      setIsMapOpening(true);
      void api.getMap(lastMapId)
        .then(({ map }) => {
          if (getToken() === token && documentSessionRef.current.canApplyLoad(restoreTicket)) {
            applyLoadedMap(map);
          }
        })
        .catch(() => {
          if (getToken() === token && documentSessionRef.current.isLatestLoad(restoreTicket)) {
            try { localStorage.removeItem(LAST_MAP_KEY); } catch { /* ignore */ }
          }
        })
        .finally(() => {
          if (mapOpeningRequestRef.current === openingRequest) setIsMapOpening(false);
        });
    }
    message.success('登录成功');
  };

  const handleLogout = () => {
    guestPreviewRequestedRef.current = false;
    guestDraftIdRef.current = null;
    setGuestDraftId(null);
    setGuestSession(false);
    setPreviewMode(false);
    setGuestReady(false);
    setAuthBooting(false);
    setAuthAction(null);
    setAuthVisible(false);
    if (!/^\/(gallery|works)(\/|$)/.test(window.location.pathname)) window.history.replaceState({}, '', '/');
    revokeBlobUrl(userProfile?.avatar);
    clearAuthSession();
    try { localStorage.removeItem(LAST_MAP_KEY); } catch { /* ignore */ }
    setUserProfile(null);
    setLines([]);
    setSections([]);
    setStations([]);
    setCurrentLineId(null);
    setCurrentMap(null);
    localProjectRef.current = null;
    setLocalProject(null);
    setSavedMaps([]);
    setMapSettings(DEFAULT_MAP_SETTINGS);
    setProfileVisible(false);
    setSettingsVisible(false);
    setAboutVisible(false);
    setBaseMapPickerStyle(null);
    setVideoModalOpen(false);
    setMapName('');
    resetHistory();
    message.info('已退出登录');
  };

  // 「新建空白方案」：从头开始一张空画布。
  // - 有内容时弹确认（避免误清当前工作）；空画布直接执行
  // - 已经保存过的方案不会被删，仍在「我的地图」里；这里只是把当前会话清掉
  // - 同时清除 localStorage 里"上次编辑方案"指针，避免刷新又自动加载回来
  const handleNewMap = () => {
    const hasContent = dirtyRef.current || lines.length > 0 || sections.length > 0 || stations.length > 0;
    const doReset = () => {
      gallerySourceRef.current = undefined;
      localProjectRef.current = null;
      setLocalProject(null);
      // 用户当前的 labelDensity 选择会带到新方案里，不被默认值覆盖
      // (跨 session 也用 localStorage 兜底，所以 readLabelDensity 也能 fallback)
      const stickyLabelDensity = mapSettingsRef.current.labelDensity || readLabelDensity();
      const stickyHideWaypoints = Boolean(mapSettingsRef.current.hideWaypoints ?? readHideWaypoints());
      if (guestDraftIdRef.current) {
        guestReadFailedRef.current = false;
        const draft = createGuestDraft(true);
        draft.mapSettings.labelDensity = stickyLabelDensity;
        draft.mapSettings.hideWaypoints = stickyHideWaypoints;
        applyGuestDraft(draft);
        return;
      }
      setLines([]);
      setSections([]);
      setStations([]);
      setCurrentLineId(null);
      setCurrentMap(null);
      setMapName('');
      setMapSettings({
        ...DEFAULT_MAP_SETTINGS,
        labelDensity: stickyLabelDensity,
        hideWaypoints: stickyHideWaypoints
      });
      try { localStorage.removeItem(LAST_MAP_KEY); } catch { /* ignore */ }
      resetHistory();
      setVideoModalOpen(false);
      message.success('已新建空白方案');
    };
    if (!hasContent) {
      doReset();
      return;
    }
    Modal.confirm({
      title: '新建空白方案？',
      content: dirtyRef.current || (!currentMap && !localProject?.filePath)
        ? '当前方案有尚未保存的内容，新建后将丢失。是否继续？'
        : localProject?.filePath
          ? '当前本地工程文件已保存在磁盘中，需要时可随时重新打开。画布即将清空。'
          : '当前方案已保存在「我的地图」，需要时可重新打开。画布即将清空。',
      okText: '新建',
      cancelText: '取消',
      onOk: doReset
    });
  };

  const handleBaseMapModeChange = (nextMode: BaseMapMode) => {
    if (nextMode === mapSettings.baseMap.mode) return;

    if (nextMode === 'amap') {
      if (!isOnline) {
        message.info('在线地理底图需要联网加载瓦片，离线状态下可使用纯画布或轻城市底图自由绘制');
        return;
      }
      let style = mapSettings.baseMap.amap?.style || 'normal';
      try {
        const remembered = localStorage.getItem('metro_amap_style');
        if (remembered === 'normal' || remembered === 'dark' || remembered === 'grey' || remembered === 'fresh') style = remembered;
      } catch { /* Default style remains available when local storage is disabled. */ }
      setBaseMapPickerStyle(style);
      return;
    }

    if (nextMode === 'light-city') {
      const switchIntoLightCity = () => {
        if (mapSettings.baseMap.lightCity && mapSettings.baseMap.lightCity.features.length > 0) {
          pushHistory();
          setMapSettings((prev) =>
            normalizeMapSettings({
              ...prev,
              baseMap: { ...prev.baseMap, mode: 'light-city' }
            })
          );
          return;
        }
        setLightCityPickerOpen(true);
      };

      if (mapSettings.baseMap.mode === 'amap' && (lines.length > 0 || stations.length > 0 || sections.length > 0)) {
        Modal.confirm({
          title: '切换到轻城市模式？',
          content: '将把当前地理底图视图中的站点位置固化为画布坐标，并叠加纸感轻城市地貌。',
          okText: '确认切换',
          cancelText: '取消',
          onOk: switchIntoLightCity
        });
        return;
      }
      switchIntoLightCity();
      return;
    }

    // nextMode === 'plain'
    const applyPlainMode = () => {
      pushHistory();
      setMapSettings((prev) => normalizeMapSettings({
        ...prev,
        baseMap: { ...prev.baseMap, mode: 'plain' }
      }));
    };

    // 从「轻城市」切回「纯画布」100% 共享世界像素坐标，零偏移直切，无需打断用户的二次确认弹窗
    if (mapSettings.baseMap.mode === 'light-city' || (lines.length === 0 && stations.length === 0 && sections.length === 0)) {
      applyPlainMode();
      return;
    }

    Modal.confirm({
      title: '切换到纯画布？',
      content: '将把当前地理底图视图中的站点位置固化为普通画布坐标。切换后不会继续跟随真实地图缩放，但当前视觉位置会保持一致。',
      okText: '确认切换',
      cancelText: '取消',
      onOk: applyPlainMode
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
        username: values.username || userProfile?.username,
        password: nextPassword
      };

      const { user } = await api.updateMe(payload);
      touchAuthSessionUser(user);
      setUserProfile({ ...user, avatar: user.avatar || undefined, password: '' });
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
      touchAuthSessionUser(user);
      setUserProfile({ ...user, avatar: user.avatar || undefined, password: '' });
      message.success('头像已更新');
    } catch (error: any) {
      message.error(error.message || '头像更新失败');
    } finally {
      event.target.value = '';
    }
  };

  const handleOpenMapList = async () => {
    if (!userProfile) { requestGuestAuth('maps'); return; }
    setMapsVisible(true);
    if (mapsLoading) return;
    refreshSavedMaps(true);
  };

  const applyLoadedProjectData = (project: MetroProjectData, filePath: string | null) => {
    gallerySourceRef.current = undefined;
    guestDraftIdRef.current = null;
    setGuestDraftId(null);
    setGuestSession(false);
    setPreviewMode(false);
    if (!/^\/(gallery|works)(\/|$)/.test(window.location.pathname)) {
      window.history.replaceState({}, '', '/');
    }
    const nextLocal = { id: createId(), name: project.name, filePath };
    localProjectRef.current = nextLocal;
    setLocalProject(nextLocal);
    setCurrentMap(null);

    const loadedLines = normalizeLoadedLines(project.lines || []);
    const migrated = migrateLegacyGcj02MapToWgs84({
      stations: Array.isArray(project.stations) ? project.stations : [],
      sections: normalizeSections(project.sections),
      mapSettings: normalizeMapSettings(project.mapSettings)
    });
    const healed = reconcileGraph({
      lines: loadedLines,
      stations: migrated.stations,
      sections: migrated.sections
    });
    commitGraphState(healed);
    setMapSettings(migrated.mapSettings);
    setCurrentLineId(project.currentLineId || healed.lines[0]?.id || null);
    setMapName(project.name);
    setGuestInitialViewport(project.viewport);
    setGuestViewport(project.viewport);
    resetHistory();
    setGuestReady(true);
    setIsMapOpening(false);
    setVideoModalOpen(false);
  };

  const openRawProjectContent = (
    rawText: string,
    filename: string,
    filePath: string | null,
    skipConfirm = false
  ) => {
    let parsed: MetroProjectData;
    try {
      parsed = parseMetroProjectJson(rawText, filename);
    } catch (err: any) {
      message.error(err?.message || '工程文件解析失败');
      return;
    }
    const doApply = () => {
      applyLoadedProjectData(parsed, filePath);
      message.success(`已打开本地工程「${parsed.name}」`);
    };
    if (!dirtyRef.current || skipConfirm) {
      doApply();
      return;
    }
    Modal.confirm({
      title: '打开本地工程？',
      content: '当前画布有尚未保存的修改，打开新工程后将丢失。是否继续？',
      okText: '继续打开',
      cancelText: '取消',
      onOk: doApply
    });
  };

  const handleOpenLocalProject = async () => {
    if (hasDesktopBridge() && window.metroDesktop) {
      try {
        const res = await window.metroDesktop.openProjectDialog();
        if (res.canceled || typeof res.content !== 'string') return;
        openRawProjectContent(res.content, res.name || '', res.filePath || null);
      } catch (err: any) {
        message.error(err?.message || '打开本地工程失败');
      }
      return;
    }
    localFileInputRef.current?.click();
  };

  const handleLocalFileInputChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const content = await file.text();
      openRawProjectContent(content, file.name, null);
    } catch (err: any) {
      message.error(err?.message || '读取本地文件失败');
    }
  };

  const handleSaveLocalProject = async (saveAs = false): Promise<boolean> => {
    const rawTitle =
      mapName.trim() ||
      localProjectRef.current?.name ||
      currentMapRef.current?.name ||
      text.unnamedMap;
    const cleanTitle = stripProjectExtension(rawTitle) || text.unnamedMap;
    const content = serializeMetroProject({
      name: cleanTitle,
      lines: linesRef.current,
      stations: stationsRef.current,
      sections: sectionsRef.current,
      mapSettings: mapSettingsRef.current,
      currentLineId: currentLineIdRef.current,
      viewport: guestViewport
    });

    if (hasDesktopBridge() && window.metroDesktop) {
      try {
        const existingPath = localProjectRef.current?.filePath || null;
        const result = await window.metroDesktop.saveProjectFile({
          filePath: existingPath,
          suggestedName: sanitizeProjectFilename(cleanTitle),
          content,
          saveAs
        });
        if (result.canceled || !result.filePath) return false;
        const savedName = stripProjectExtension(result.name || cleanTitle) || cleanTitle;
        const nextLocal = {
          id: localProjectRef.current?.id || createId(),
          name: savedName,
          filePath: result.filePath
        };
        localProjectRef.current = nextLocal;
        setLocalProject(nextLocal);
        setCurrentMap(null);
        if (guestDraftIdRef.current) {
          guestDraftIdRef.current = null;
          setGuestDraftId(null);
          setGuestSession(false);
          setPreviewMode(false);
        }
        setMapName(savedName);
        setSaveMapVisible(false);
        clearDirty();
        message.success(
          existingPath && !saveAs
            ? '已保存最新修改到本机文件'
            : `已保存本机工程「${savedName}.metro」`
        );
        return true;
      } catch (err: any) {
        message.error(err?.message || '保存本机文件失败');
        return false;
      }
    }

    // 浏览器环境兜底下载 .metro 工程文件
    try {
      const filename = `${sanitizeProjectFilename(cleanTitle)}.metro`;
      const blob = new Blob([content], { type: 'application/json' });
      if (isAndroidClient) {
        const saved = await saveAndroidExport(blob, filename);
        if (saved) {
          clearDirty();
          message.success('工程文件已保存');
        }
        return saved;
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setSaveMapVisible(false);
      clearDirty();
      message.success(`已导出工程文件「${filename}」`);
      return true;
    } catch (err: any) {
      message.error(err?.message || '导出工程文件失败');
      return false;
    }
  };

  const handleOpenSaveMap = () => {
    // 1) 当前已绑定本机 .metro 文件路径：直接一键原地写盘，无需弹窗、无需登录
    if (localProjectRef.current?.filePath && hasDesktopBridge()) {
      if (!dirtyRef.current) {
        message.success(language === 'en-US' ? 'Local file is up to date' : '本机工程文件已是最新保存状态');
        return;
      }
      void handleSaveLocalProject(false);
      return;
    }

    // 2) 桌面客户端处于未登录或离线状态：直接弹出系统保存框保存为本机 .metro 文件，不强制拦截登录
    if (hasDesktopBridge() && (!userProfile || !isOnline)) {
      if (currentMap && !isOnline) {
        message.info('当前处于离线状态，先为你另存为本机 .metro 工程文件');
      }
      void handleSaveLocalProject(true);
      return;
    }

    if (!userProfile) { void persistGuestDraft(); requestGuestAuth('save'); return; }
    if (saveMapSaving) return;
    // 已保存过的云端地图：有改动时直接一键静默保存，不再每次打断弹出“覆盖保存”框；无改动时轻提示
    if (currentMap) {
      if (!dirtyRef.current) {
        message.success(language === 'en-US' ? 'All changes saved' : '当前方案已是最新保存状态');
        return;
      }
      void handleSaveMap();
      return;
    }
    setMapName(localProjectRef.current?.name || (guestDraftIdRef.current ? mapName : ''));
    setSaveMapVisible(true);
  };

  const handleSaveMap = async () => {
    if (!userProfile) { requestGuestAuth('save'); return; }
    if (saveMapInFlightRef.current) return;
    const savingGuestId = guestDraftIdRef.current;
    const trimmed = mapName.trim();
    const fallbackName = currentMap?.name || `我的地图 ${new Date().toLocaleString()}`;
    const name = trimmed || fallbackName;
    const wasVisible = saveMapVisible;
    const ticket = documentSessionRef.current.capture();
    const requestToken = getToken();
    const targetMapId = currentMap?.id;
    const snapshot = cloneDoc({ lines, stations, sections, mapSettings });
    saveMapInFlightRef.current = true;
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
      const { map } = targetMapId
        ? await api.updateMap(targetMapId, { name, ...snapshot })
        : await api.createMap({ name, ...snapshot, clientDraftId: savingGuestId || undefined, gallerySourceToken: gallerySourceRef.current });
      if (getToken() !== requestToken) {
        message.destroy('save-map');
        return;
      }
      upsertSavedMap({ ...map, ...counts });
      if (documentSessionRef.current.isSameDocument(ticket)) {
        if (!targetMapId && userProfile?.id) {
          migrateDraftAISessions(userProfile.id, savingGuestId || 'draft', map.id, name);
        }
        setCurrentMap({ ...map, ...counts });
        localProjectRef.current = null;
        setLocalProject(null);
        if (savingGuestId && guestDraftIdRef.current === savingGuestId) {
          guestDraftIdRef.current = null;
          setGuestDraftId(null);
          setGuestSession(false);
          setPreviewMode(false);
          if (!/^\/(gallery|works)(\/|$)/.test(window.location.pathname)) window.history.replaceState({}, '', '/');
          void deleteGuestDraft().catch(() => { /* Cloud save is already confirmed. */ });
        }
        setMapName('');
        try { localStorage.setItem(LAST_MAP_KEY, map.id); } catch { /* ignore */ }
        if (documentSessionRef.current.isUnchanged(ticket)) {
          clearDirty();
          message.success({ content: targetMapId ? '已保存最新修改' : '地图已保存', key: 'save-map' });
        } else {
          message.success({ content: '已保存提交时的版本，后续修改仍需保存', key: 'save-map' });
        }
      } else {
        message.success({ content: `“${map.name}”已保存`, key: 'save-map' });
      }
    } catch (error: any) {
      if (getToken() === requestToken) {
        if (wasVisible && documentSessionRef.current.isSameDocument(ticket)) setSaveMapVisible(true);
        message.error({ content: error.message || '保存地图失败', key: 'save-map' });
      } else message.destroy('save-map');
    } finally {
      saveMapInFlightRef.current = false;
      setSaveMapSaving(false);
    }
  };

  const resumeAuthActionRef = useRef({ save: handleOpenSaveMap, maps: handleOpenMapList });
  resumeAuthActionRef.current = { save: handleOpenSaveMap, maps: handleOpenMapList };
  useEffect(() => {
    if (!userProfile || !authAction) return;
    setAuthAction(null);
    if (authAction === 'save') resumeAuthActionRef.current.save();
    if (authAction === 'maps') void resumeAuthActionRef.current.maps();
    if (authAction === 'ai') setAiModalOpen(true);
    if (authAction === 'video') setVideoModalOpen(true);
    if (authAction === 'profile') setProfileVisible(true);
  }, [userProfile, authAction]);

  // 把服务端返回的 map 应用到本地状态，纯 setter 操作，便于复用（boot 自动加载也调它）
  const applyLoadedMap = (map: any) => {
    gallerySourceRef.current = undefined;
    localProjectRef.current = null;
    setLocalProject(null);
    guestDraftIdRef.current = null;
    setGuestDraftId(null);
    setGuestSession(false);
    setPreviewMode(false);
    if (!/^\/(gallery|works)(\/|$)/.test(window.location.pathname)) window.history.replaceState({}, '', '/');
    const loadedLines = normalizeLoadedLines(map.lines || []);
    const rawSettings = (map.mapSettings && typeof map.mapSettings === 'object' ? map.mapSettings : undefined) as Partial<MapSettings> | undefined;
    const baseSettings = normalizeMapSettings(rawSettings);
    if (!rawSettings?.labelDensity) {
      baseSettings.labelDensity = readLabelDensity();
    }
    const migrated = migrateLegacyGcj02MapToWgs84({
      stations: Array.isArray(map.stations) ? map.stations : [],
      sections: normalizeSections(map.sections),
      mapSettings: baseSettings
    });
    const healed = reconcileGraph({
      lines: loadedLines,
      stations: migrated.stations,
      sections: migrated.sections
    });
    commitGraphState(healed);
    setMapSettings(migrated.mapSettings);
    setCurrentLineId(healed.lines[0]?.id || null);
    setCurrentMap({
      id: map.id,
      name: map.name,
      createdAt: map.createdAt,
      updatedAt: map.updatedAt
    });
    setMapName(map.name);
    resetHistory();
    setVideoModalOpen(false);
    try {
      localStorage.setItem(LAST_MAP_KEY, map.id);
    } catch {
      /* localStorage 满了 / 隐私模式 / 其他失败都不影响主流程 */
    }
  };

  const handleLoadMap = async (mapId: string) => {
    const load = async () => {
      const ticket = documentSessionRef.current.beginLoad();
      const requestToken = getToken();
      const openingRequest = ++mapOpeningRequestRef.current;
      setIsMapOpening(true);
      try {
        const { map } = await api.getMap(mapId);
        if (getToken() !== requestToken || !documentSessionRef.current.isLatestLoad(ticket)) return;
        if (!documentSessionRef.current.canApplyLoad(ticket)) {
          message.warning('加载期间有新修改，已保留当前画布。请保存后再打开地图。');
          return;
        }
        applyLoadedMap(map);
        setMapsVisible(false);
        message.success('地图已加载');
      } catch (error: any) {
        if (getToken() === requestToken && documentSessionRef.current.isLatestLoad(ticket)) {
          message.error(error.message || '加载地图失败');
        }
      } finally {
        if (mapOpeningRequestRef.current === openingRequest) setIsMapOpening(false);
      }
    };
    if (!dirtyRef.current) { await load(); return; }
    Modal.confirm({
      title: '打开其他地图？',
      content: '当前方案有未保存的修改，打开后将丢失。是否继续？',
      okText: '继续打开', cancelText: '取消', onOk: load
    });
  };

  const handleDeleteMap = async (mapId: string) => {
    const requestToken = getToken();
    try {
      await api.deleteMap(mapId);
      if (getToken() !== requestToken) return;
      setSavedMaps((prev) => prev.filter((item) => item.id !== mapId));

      if (currentMapRef.current?.id === mapId) {
        setCurrentMap(null);
        setMapName('');
        // 删除云端存档后保留正在编辑的内容，可另存为新地图。
        documentSessionRef.current.reset();
        markDirty();
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
    const requestToken = getToken();
    try {
      // 只发 name 字段，后端 storage.updateMap 会保留 lines/stations/sections/mapSettings
      const { map } = await api.updateMap(mapId, { name: trimmed });
      if (getToken() !== requestToken) return;
      setSavedMaps(prev =>
        prev
          .map(item =>
            item.id === mapId ? { ...item, name: map.name, updatedAt: map.updatedAt } : item
          )
          .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      );
      if (currentMapRef.current?.id === mapId) {
        setCurrentMap(prev => prev?.id === mapId ? { ...prev, name: map.name, updatedAt: map.updatedAt } : prev);
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
    const requestToken = getToken();
    try {
      const { map } = await api.getMap(mapId);
      if (getToken() !== requestToken) return;
      const dupName = `${map.name} 副本`;
      const { map: created } = await api.createMap({
        name: dupName,
        lines: map.lines || [],
        stations: map.stations || [],
        sections: map.sections || [],
        mapSettings: map.mapSettings, sourcePrivateMapId: mapId
      });
      if (getToken() !== requestToken) return;
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
    if (!userProfile && !isDesktopClient && !hasDesktopBridge()) { requestGuestAuth('video'); return; }
    if (videoAbortRef.current) return;
    if (!stageRef.current) {
      message.error('画布尚未准备好');
      return;
    }

    setVideoModalOpen(false);
    setIsExporting(true);
    setVideoProgress({ phase: 'preparing', percent: 0, elapsedSec: 0, totalSec: 0 });
    const controller = new AbortController();
    videoAbortRef.current = controller;

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
        aspectRatio: config.aspectRatio,
        resolution: config.resolution,
        fps: config.fps,
        speedMultiplier: config.speedMultiplier,
        cameraMode: config.cameraMode,
        unopenedStyle: config.unopenedStyle,
        dateMode: config.dateMode,
        showYearBadge: config.showYearBadge,
        showLineLegend: config.showLineLegend,
        signal: controller.signal,
        onProgress: setVideoProgress,
        fetchAmapStaticMap: api.getAmapStaticMap,
        onWarn: (msg) => message.warning(msg)
      });
      const isMp4 = blob.type.startsWith('video/mp4');
      const extension = isMp4 ? 'mp4' : 'webm';
      const fileTitle = config.title.replace(/[<>:"/\\|?*]/g, '_').trim() || 'metro-demo';
      const filename = `${fileTitle}-${Date.now()}.${extension}`;
      if (isAndroidClient) {
        const saved = await saveAndroidExport(blob, filename);
        if (saved) message.success('视频已保存');
        else message.info('已取消保存');
      } else if (hasDesktopBridge()) {
        if (exportedVideoUrlRef.current) {
          URL.revokeObjectURL(exportedVideoUrlRef.current);
        }
        const url = URL.createObjectURL(blob);
        exportedVideoUrlRef.current = url;
        setExportedVideo({ url, filename, format: isMp4 ? 'MP4' : 'WebM' });
        const saved = await saveDesktopExport(blob, filename);
        if (saved) message.success(`视频已保存到本机（${isMp4 ? 'MP4' : 'WebM'}）`);
        else message.info('已取消文件保存，仍可在预览窗口查看或重新保存');
      } else {
        if (exportedVideoUrlRef.current) {
          URL.revokeObjectURL(exportedVideoUrlRef.current);
        }
        const url = URL.createObjectURL(blob);
        exportedVideoUrlRef.current = url;
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setExportedVideo({ url, filename, format: isMp4 ? 'MP4' : 'WebM' });
        message.success(`视频导出完成（${isMp4 ? 'MP4' : 'WebM'}），已触发下载`);
      }
    } catch (error: any) {
      if (error?.name === 'AbortError') message.info('已取消视频导出');
      else {
        console.error(error);
        message.error(error?.message || '导出失败，请重试');
      }
    } finally {
      videoAbortRef.current = null;
      setIsExporting(false);
    }
  };

  // 把 AI 返回的 operations 列表逐条 apply 到 lines / stations / sections 上。
  // 一组 operations 算作一次撤销单位（开头只 pushHistory 一次）。
  // 所有操作走"新数组替换"路径，避免半截 React state 引用旧的另一半。
  const applyAIOperations = (operations: AIOperation[]) => {
    if (!operations.length) return 0;
    pushHistory();
    let nextLines = [...linesRef.current];
    let nextStations = [...stationsRef.current];
    let nextSections = [...sectionsRef.current];
    let applied = 0;

    for (const op of operations) {
      switch (op.type) {
        case 'create_new_line_with_stations': {
          const cleanNames = (op.stationNames || []).map((n) => (typeof n === 'string' ? n.trim() : '')).filter(Boolean);
          if (cleanNames.length < 2) break;

          const dirOrder = ['east_west', 'north_south', 'nw_se', 'sw_ne'] as const;
          const dir = op.direction || dirOrder[nextLines.length % dirOrder.length];
          const vecMap = {
            east_west: { ux: 1, uy: 0 },
            north_south: { ux: 0, uy: 1 },
            nw_se: { ux: Math.SQRT1_2, uy: Math.SQRT1_2 },
            sw_ne: { ux: Math.SQRT1_2, uy: -Math.SQRT1_2 }
          };
          const { ux, uy } = vecMap[dir] || vecMap.east_west;
          const stepPx = 92;
          const isAmap = mapSettingsRef.current.baseMap.mode === 'amap';
          const amapCenter = mapSettingsRef.current.baseMap.amap?.center || [116.397428, 39.90923];
          const stepLng = 0.015;
          const stepLat = 0.0125;

          const existingByName = new Map<string, Station>();
          nextStations.forEach((st) => existingByName.set(st.name.trim(), st));

          // 若新线路穿过已有同名站点，以首个匹配的已有站点为十字换乘锚点对齐坐标；否则围绕画布中心对称排布
          let pivotIdx = cleanNames.findIndex((n) => existingByName.has(n));
          let originX = stageRef.current?.width?.() ? stageRef.current.width() / 2 : 520;
          let originY = stageRef.current?.height?.() ? stageRef.current.height() / 2 : 340;
          let originLng = amapCenter[0];
          let originLat = amapCenter[1];

          if (pivotIdx >= 0) {
            const pivotStation = existingByName.get(cleanNames[pivotIdx])!;
            originX = pivotStation.x;
            originY = pivotStation.y;
            if (typeof pivotStation.lng === 'number' && typeof pivotStation.lat === 'number') {
              originLng = pivotStation.lng;
              originLat = pivotStation.lat;
            }
          } else {
            if (nextStations.length > 0) {
              originX = nextStations.reduce((acc, s) => acc + s.x, 0) / nextStations.length;
              originY = nextStations.reduce((acc, s) => acc + s.y, 0) / nextStations.length;
              const geoStations = nextStations.filter((s) => typeof s.lng === 'number' && typeof s.lat === 'number');
              if (geoStations.length > 0) {
                originLng = geoStations.reduce((acc, s) => acc + (s.lng || 0), 0) / geoStations.length;
                originLat = geoStations.reduce((acc, s) => acc + (s.lat || 0), 0) / geoStations.length;
              }
              const perpShift = ((nextLines.length % 3) - 1) * 54;
              originX += -uy * perpShift;
              originY += ux * perpShift;
              originLng += -uy * 0.008;
              originLat += -ux * 0.0065;
            }
            pivotIdx = (cleanNames.length - 1) / 2;
          }

          const lineStations: Station[] = [];
          const createdStations: Station[] = [];
          cleanNames.forEach((stName, idx) => {
            const existing = existingByName.get(stName);
            if (existing) {
              lineStations.push(existing);
              return;
            }
            const delta = idx - pivotIdx;
            const created: Station = {
              id: createId(),
              name: stName,
              x: originX + ux * stepPx * delta,
              y: originY + uy * stepPx * delta,
              ...(isAmap
                ? {
                    lng: originLng + ux * stepLng * delta,
                    lat: originLat - uy * stepLat * delta
                  }
                : {})
            };
            existingByName.set(stName, created);
            createdStations.push(created);
            lineStations.push(created);
          });

          const lineId = createId();
          const newSectionList: Section[] = [];
          for (let i = 0; i < lineStations.length - 1; i += 1) {
            if (lineStations[i].id === lineStations[i + 1].id) continue;
            newSectionList.push({
              id: createId(),
              lineId,
              startStationId: lineStations[i].id,
              endStationId: lineStations[i + 1].id
            });
          }
          nextStations = [...nextStations, ...createdStations];
          nextSections = [...nextSections, ...newSectionList];
          nextLines.push({
            id: lineId,
            name: op.name,
            color: op.color,
            stationIds: lineStations.map((s) => s.id),
            sectionIds: newSectionList.map((s) => s.id)
          });
          if (!currentLineIdRef.current) {
            setCurrentLineId(lineId);
          }
          applied += 1;
          break;
        }
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
    const curLines = linesRef.current;
    const curStations = stationsRef.current;
    const lineName = (id: string) => curLines.find((l) => l.id === id)?.name || `#${id.slice(0, 6)}`;
    const stationName = (id: string) => curStations.find((s) => s.id === id)?.name || `#${id.slice(0, 6)}`;
    switch (op.type) {
      case 'create_new_line_with_stations':
        return `新建线路「${op.name}」（${op.color}），包含 ${op.stationNames.length} 个站点：${op.stationNames.join('、')}`;
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
        lines: linesRef.current.map((l) => ({
          id: l.id,
          name: l.name,
          color: l.color,
          stationIds: [...l.stationIds]
        })),
        stations: stationsRef.current.map((s) => ({ id: s.id, name: s.name }))
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
          return { ok: false, message: '地理底图模式暂不支持像素坐标放置，请切到纯画布或直接在画布上点击落站' };
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

  const handleExportImage = async () => {
    const stage = stageRef.current;
    if (!stage) { message.error('无法获取画布'); return; }
    const original = { scale: stage.scaleX(), x: stage.x(), y: stage.y(), width: stage.width(), height: stage.height() };
    let dataUrl = '';
    try {
      if (mapSettingsRef.current.baseMap.mode === 'amap') {
        // 地理底图模式下直接将免 Key 底图 Canvas 与当前视口 Konva 图层无损合成为高清 PNG
        const mapCanvas = document.querySelector<HTMLCanvasElement>('.metro-amap-layer canvas');
        const pr = Math.min(2, window.devicePixelRatio || 2);
        const stageCanvas = stage.toCanvas({ pixelRatio: pr });
        const outCanvas = document.createElement('canvas');
        outCanvas.width = stageCanvas.width;
        outCanvas.height = stageCanvas.height;
        const outCtx = outCanvas.getContext('2d');
        if (!outCtx) throw new Error('无法创建导出画布');
        outCtx.fillStyle = mapSettingsRef.current.baseMap.amap?.style === 'dark' ? '#0f172a' : '#f1f5f9';
        outCtx.fillRect(0, 0, outCanvas.width, outCanvas.height);
        if (mapCanvas && mapCanvas.width > 0 && mapCanvas.height > 0) {
          outCtx.drawImage(mapCanvas, 0, 0, outCanvas.width, outCanvas.height);
        }
        outCtx.drawImage(stageCanvas, 0, 0, outCanvas.width, outCanvas.height);
        dataUrl = outCanvas.toDataURL('image/png', 1);
      } else {
        stage.scale({ x: 1, y: 1 });
        stage.position({ x: 0, y: 0 });
        let minX = 0;
        let minY = 0;
        let maxX = original.width;
        let maxY = original.height;
        if (stations.length > 0) {
          minX = Infinity;
          minY = Infinity;
          maxX = -Infinity;
          maxY = -Infinity;
          for (let i = 0; i < stations.length; i++) {
            const sx = stations[i].x;
            const sy = stations[i].y;
            if (sx < minX) minX = sx;
            if (sy < minY) minY = sy;
            if (sx > maxX) maxX = sx;
            if (sy > maxY) maxY = sy;
          }
        }
        const width = Math.max(maxX - minX + 200, 800);
        const height = Math.max(maxY - minY + 200, 600);
        // 大尺寸线网下限制导出纹理边长与总像素预算，防止浏览器/移动端 WebView 超出 Canvas 上限导致空白或崩溃
        const maxSide = isAndroidClient ? 8192 : 12288;
        const maxArea = isAndroidClient ? 16_777_216 : 36_000_000;
        const safePixelRatio = Math.max(
          0.25,
          Math.min(2, maxSide / Math.max(1, width, height), Math.sqrt(maxArea / Math.max(1, width * height)))
        );
        stage.width(width); stage.height(height);
        stage.position({ x: (width - maxX + minX) / 2 - minX, y: (height - maxY + minY) / 2 - minY });
        dataUrl = stage.toDataURL({ pixelRatio: safePixelRatio, mimeType: 'image/png', quality: 1 });
      }
    } catch (error) {
      console.error('导出图片失败:', error);
      message.error('导出图片失败，请重试');
      return;
    } finally {
      // Restore the interactive canvas before opening Android's system picker.
      stage.scale({ x: original.scale, y: original.scale });
      stage.position({ x: original.x, y: original.y });
      stage.width(original.width); stage.height(original.height);
      stage.batchDraw();
    }
    try {
      const filename = `metro-line-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.png`;
      if (isAndroidClient) {
        const blob = await (await fetch(dataUrl)).blob();
        const saved = await saveAndroidExport(blob, filename);
        if (saved) message.success('图片已保存');
        else message.info('已取消保存');
      } else if (hasDesktopBridge()) {
        const blob = await (await fetch(dataUrl)).blob();
        const saved = await saveDesktopExport(blob, filename);
        if (saved) message.success('图片已保存到本机');
        else message.info('已取消保存');
      } else {
        const link = document.createElement('a');
        link.download = filename; link.href = dataUrl;
        document.body.appendChild(link); link.click(); link.remove();
        message.success('图片导出成功');
      }
    } catch (error: any) { message.error(error?.message || '图片保存失败，请重试'); }
  };

  const handleExportSvg = async () => {
    try {
      const svgContent = buildMetroSvg({
        lines: linesRef.current,
        stations: stationsRef.current,
        sections: sectionsRef.current,
        mapSettings: mapSettingsRef.current
      });
      const safeName = sanitizeProjectFilename(currentMap?.name || localProject?.name || mapName || 'metro-network');
      const filename = `${safeName}.svg`;
      const blob = new Blob([svgContent], { type: 'image/svg+xml;charset=utf-8' });
      if (isAndroidClient) {
        const saved = await saveAndroidExport(blob, filename);
        if (saved) message.success('SVG 矢量图已保存');
        else message.info('已取消保存');
      } else if (hasDesktopBridge()) {
        const saved = await saveDesktopExport(blob, filename);
        if (saved) message.success('SVG 矢量图已保存到本机');
        else message.info('已取消保存');
      } else {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.download = filename;
        link.href = url;
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        message.success('SVG 矢量图导出成功');
      }
    } catch (error: any) {
      message.error(error?.message || '导出 SVG 失败，请重试');
    }
  };

  const isSignedInView = Boolean(userProfile) || authBooting;
  const displayName = userProfile?.username || (authBooting ? (language === 'en-US' ? 'Syncing…' : '同步中…') : '访客预览');
  const displayInitial = (userProfile?.username || userProfile?.email || userProfile?.phone || 'M').charAt(0).toUpperCase();
  const mapDisplayName = currentMap?.name || localProject?.name || (guestDraftId ? mapName : '') || text.unnamedMap;

  const desktopDispatchRef = useRef({
    newMap: handleNewMap,
    openLocal: handleOpenLocalProject,
    save: handleOpenSaveMap,
    saveAsLocal: () => handleSaveLocalProject(true),
    exportPng: handleExportImage,
    openVideo: () => {
      if (userProfile || isDesktopClient || hasDesktopBridge()) setVideoModalOpen(true);
      else requestGuestAuth('video');
    },
    openProjectContent: openRawProjectContent
  });
  desktopDispatchRef.current = {
    newMap: handleNewMap,
    openLocal: handleOpenLocalProject,
    save: handleOpenSaveMap,
    saveAsLocal: () => handleSaveLocalProject(true),
    exportPng: handleExportImage,
    openVideo: () => {
      if (userProfile || isDesktopClient || hasDesktopBridge()) setVideoModalOpen(true);
      else requestGuestAuth('video');
    },
    openProjectContent: openRawProjectContent
  };

  useEffect(() => {
    const bridge = window.metroDesktop;
    if (!bridge) return;
    let cancelled = false;
    void bridge.consumeLaunchProject().then((launched) => {
      if (cancelled || !launched) return;
      launchProjectClaimedRef.current = true;
      desktopDispatchRef.current.openProjectContent(
        launched.content,
        launched.name,
        launched.filePath,
        true
      );
    }).catch(() => {});

    const unsubscribe = bridge.onMenuCommand((cmd: DesktopMenuCommand) => {
      if (cmd.type === 'new') desktopDispatchRef.current.newMap();
      else if (cmd.type === 'open') void desktopDispatchRef.current.openLocal();
      else if (cmd.type === 'save') desktopDispatchRef.current.save();
      else if (cmd.type === 'save-as') void desktopDispatchRef.current.saveAsLocal();
      else if (cmd.type === 'export-png') void desktopDispatchRef.current.exportPng();
      else if (cmd.type === 'export-video') desktopDispatchRef.current.openVideo();
      else if (cmd.type === 'open-project-data') {
        desktopDispatchRef.current.openProjectContent(cmd.content, cmd.name, cmd.filePath);
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    window.metroDesktop?.setDocumentWindowState({
      title: mapDisplayName,
      dirty,
      filePath: localProject?.filePath || null
    });
  }, [mapDisplayName, dirty, localProject?.filePath]);

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if (/^\/(gallery|works)(\/|$)/.test(window.location.pathname)) return;
      const accel = event.ctrlKey || event.metaKey;
      if (!accel || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 's') {
        event.preventDefault();
        if (event.shiftKey) void desktopDispatchRef.current.saveAsLocal();
        else desktopDispatchRef.current.save();
      } else if (key === 'o' && !event.shiftKey) {
        event.preventDefault();
        void desktopDispatchRef.current.openLocal();
      }
    };
    window.addEventListener('keydown', onShortcut);
    return () => window.removeEventListener('keydown', onShortcut);
  }, []);

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
    } else if (localProject?.filePath && hasDesktopBridge()) {
      void handleSaveLocalProject(true);
    } else {
      handleOpenSaveMap();
    }
  };

  useEffect(() => {
    if (mapsVisible && userProfile) gallery.mine().then(r=>setMyPublications(r.works)).catch(()=>{});
  }, [mapsVisible,userProfile]);
  const newMapMenuItem = { key: 'new-map', icon: <FileAddOutlined />, label: language === 'en-US' ? 'New blank map' : '新建空白方案', onClick: handleNewMap };
  const localProjectMenuItems = [
    {
      key: 'open-local-project',
      icon: <FolderOpenOutlined />,
      label: language === 'en-US' ? 'Open local project…' : '打开本地工程…',
      onClick: () => { void handleOpenLocalProject(); }
    },
    {
      key: 'save-local-project',
      icon: <SaveOutlined />,
      label: language === 'en-US'
        ? (hasDesktopBridge() ? 'Save as local project…' : 'Export .metro file')
        : (hasDesktopBridge() ? '另存为本地工程…' : '导出本地工程 (.metro)'),
      onClick: () => { void handleSaveLocalProject(true); }
    }
  ];
  const openGallery = () => {
    if (!isOnline) {
      message.info(language === 'en-US' ? 'Works gallery requires an internet connection' : '作品广场需要联网浏览');
      return;
    }
    void persistGuestDraft();
    setGuestInitialViewport(guestViewport);
    navigatePublic('/gallery');
  };
  const settingsMenuItems = [
    { key: 'gallery', className: 'metro-user-menu__mobile-only', icon: <AppstoreOutlined />, label: language === 'en-US' ? 'Gallery' : '作品广场', onClick: openGallery },
    { key: 'settings', icon: <SettingOutlined />, label: language === 'en-US' ? 'Settings' : '设置', onClick: () => setSettingsVisible(true) },
    ...(!isAndroidClient && !isDesktopClient ? [{ key: 'download-client', icon: <DownloadOutlined />,
      label: <a href={isAndroidDevice ? '/android.html' : '/downloads.html'} target="_blank" rel="noopener noreferrer">{language === 'en-US' ? 'Download app' : '下载客户端'}</a> }] : []),
    { key: 'about', icon: <InfoCircleOutlined />, label: language === 'en-US' ? 'About us' : '关于我们', onClick: () => setAboutVisible(true) }
  ];
  const guestBackupMenuItems = guestStorageError ? [
    { type: 'divider' as const },
    { key: 'draft-error', disabled: true, label: '本机草稿保存遇到问题' },
    { key: 'retry-draft', label: '重试保存草稿', onClick: () => { void retryGuestStorage(); } },
    { key: 'backup-draft', label: '下载草稿备份', onClick: () => { void downloadGuestBackup(); } }
  ] : [];
  // 已登录与未登录共用统一尺寸与视觉语言的账号下拉菜单
  const userMenuItems = isSignedInView ? [
    {
      key: 'identity',
      disabled: true,
      className: 'metro-user-menu__header',
      label: (
        <div className="metro-user-menu__account">
          <span className="metro-user-menu__account-name">{displayName}</span>
          {maskedEmail ? <span className="metro-user-menu__account-sub">{maskedEmail}</span> : null}
        </div>
      )
    },
    { type: 'divider' as const },
    newMapMenuItem,
    ...localProjectMenuItems,
    { key: 'maps', icon: <FolderOpenOutlined />, label: language === 'en-US' ? 'My maps' : '我的地图', onClick: handleOpenMapList },
    { type: 'divider' as const },
    { key: 'profile', icon: <UserOutlined />, label: language === 'en-US' ? 'Account' : '个人中心', onClick: () => setProfileVisible(true) },
    ...settingsMenuItems,
    { type: 'divider' as const },
    { key: 'logout', icon: <LogoutOutlined />, label: language === 'en-US' ? 'Sign out' : '退出登录', danger: true, onClick: handleLogout }
  ] : [
    {
      key: 'unlock',
      className: 'metro-user-menu__unlock-card',
      label: (
        <div className="metro-user-menu__unlock-body">
          <div className="metro-user-menu__unlock-title">
            <UserOutlined />
            <strong>{language === 'en-US' ? 'Sign in / Register' : '登录 / 注册账号'}</strong>
          </div>
          <span className="metro-user-menu__unlock-desc">
            {language === 'en-US' ? 'Cloud maps · AI assistant · Video export' : '解锁云端存档 · AI 助手 · 视频导出'}
          </span>
        </div>
      ),
      onClick: () => requestGuestAuth(null)
    },
    { type: 'divider' as const },
    newMapMenuItem,
    ...localProjectMenuItems,
    { key: 'maps-guest', icon: <FolderOpenOutlined />, label: language === 'en-US' ? 'My maps' : '我的地图', onClick: handleOpenMapList },
    { key: 'demo-animation', icon: <PlaySquareOutlined />, label: language === 'en-US' ? 'Demo preview' : '观看动态示例', onClick: () => setGuestAnimationOpen(true) },
    { type: 'divider' as const },
    ...settingsMenuItems,
    ...guestBackupMenuItems,
    { type: 'divider' as const },
    { key: 'return-login', icon: <LogoutOutlined />, label: language === 'en-US' ? 'Welcome page' : '返回欢迎页', onClick: () => {
      void persistGuestDraft(); guestPreviewRequestedRef.current = false; setGuestSession(false); setPreviewMode(false); if (!/^\/(gallery|works)(\/|$)/.test(window.location.pathname)) window.history.replaceState({}, '', '/');
    } }
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
              colorPrimary: '#2563eb',
              borderRadius: 8,
              colorText: '#0f172a',
              colorTextSecondary: '#475569',
              colorBorder: '#dde4ee',
              colorBorderSecondary: '#edf2f7',
              colorBgLayout: '#e9eef5'
            }
    }),
    [resolvedInterfaceTheme]
  );

  const returnToEditor = () => {navigatePublic('/');if (!isSignedInView && !previewMode) guestRestorePromiseRef.current = startGuestPreview();};
  const copyPublicWork = async (data: Awaited<ReturnType<typeof gallery.fork>>) => {
    if (dirty || (!userProfile && stations.length > 0)) {
      const confirmed = await new Promise<boolean>(resolve => Modal.confirm({title:'在工作台打开副本？',content:userProfile?'当前未保存的修改将被替换，请先确认已保存。':'副本将替换当前本机草稿。',okText:'打开副本',cancelText:'取消',onOk:()=>resolve(true),onCancel:()=>resolve(false)}));
      if (!confirmed) return;
    }
    if (userProfile) {
      const sessionToken=getToken();
      const {map} = await api.createMap({name:data.name,...data.snapshot,gallerySourceToken:data.sourceToken,clientDraftId:createId()});
      if(getToken()!==sessionToken)return;
      applyLoadedMap({...map,...data.snapshot});
      upsertSavedMap({...map,lineCount:data.snapshot.lines.length,stationCount:data.snapshot.stations.length,sectionCount:data.snapshot.sections.length});
    } else {
      await persistGuestDraft();
      const draft:GuestDraft={version:1,id:createId(),updatedAt:Date.now(),name:data.name,...data.snapshot,currentLineId:data.snapshot.lines[0]?.id||null,gallerySourceToken:data.sourceToken};
      await writeGuestDraft(draft);applyGuestDraft(draft);setGuestSession(true);setPreviewMode(true);
    }
    setGuestInitialViewport(undefined);navigatePublic('/');message.success('副本已打开，可以继续设计');
  };
  if (publicRoute) return <ConfigProvider theme={{token:{colorPrimary:'#2563eb',borderRadius:8,fontFamily:'Inter, PingFang SC, Microsoft YaHei, sans-serif'}}}><AntdApp>
    <GalleryPage path={publicPath} user={userProfile} onNavigate={navigatePublic} onEditor={returnToEditor} onAuthenticated={handleAuthenticated} onCopy={copyPublicWork}/>
  </AntdApp></ConfigProvider>;

  if (!isSignedInView && !previewMode) {
    return (
      <ConfigProvider theme={antdThemeConfig}>
        <AntdApp className="metro-antd-root" data-interface-theme={resolvedInterfaceTheme}>
          <div className="auth-layout" data-interface-theme={resolvedInterfaceTheme}>
            <AuthPanel onAuthenticated={handleAuthenticated} onPreview={() => { guestRestorePromiseRef.current = startGuestPreview(); }} />
          </div>
        </AntdApp>
      </ConfigProvider>
    );
  }

  return (
    <ConfigProvider theme={antdThemeConfig}>
      <AntdApp className="metro-antd-root" data-interface-theme={resolvedInterfaceTheme}>
    <PublishDialog source={publishSource} user={userProfile} onClose={()=>setPublishSource(null)} onDone={()=>{gallery.mine().then(r=>setMyPublications(r.works)).catch(()=>{});}}/>
    <GuestAnimationPreview open={guestAnimationOpen} onClose={() => setGuestAnimationOpen(false)} />
    <DraggableModal
      title={
        authAction === 'save'
          ? '登录以保存地图'
          : authAction === 'maps'
            ? '登录查看我的地图'
            : authAction === 'ai'
              ? '登录使用 AI 助手'
              : authAction === 'video'
                ? '登录导出动态视频'
                : '登录或注册账号'
      }
      open={authVisible}
      onCancel={() => { setAuthVisible(false); setAuthAction(null); }}
      footer={null}
      width={420}
      className="metro-guest-auth"
      destroyOnHidden
    >
      <AuthPanel
        embedded
        contextHint={
          authAction === 'save'
            ? '登录后当前画布草稿将自动保留，可直接保存至云端。'
            : authAction === 'ai'
              ? '登录后即可使用自然语言驱动 AI 规划与修改线网。'
              : authAction === 'video'
                ? '登录后即可导出高清线路建设历程动态视频。'
                : '登录后自动同步云端地图并解锁全部专业能力。'
        }
        onAuthenticated={handleAuthenticated}
      />
      {authAction === 'ai' ? (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--color-border, #e2e8f0)', textAlign: 'center' }}>
          <Button
            type="link"
            size="small"
            onClick={() => {
              setAuthVisible(false);
              setAuthAction(null);
              setAiModalOpen(true);
              setAiApiSettingsOpen(true);
            }}
          >
            已有 DeepSeek / OpenAI 等密钥？免登录直接填写 API Key 使用 →
          </Button>
        </div>
      ) : null}
    </DraggableModal>
    <div className="metro-app-shell" data-interface-theme={resolvedInterfaceTheme}>
      <input
        ref={localFileInputRef}
        type="file"
        accept=".metro,.json,application/json"
        onChange={handleLocalFileInputChange}
        style={{ display: 'none' }}
      />
      <Layout className="metro-workbench">
        <Header className="metro-header">
          <div className="app-header">
            <section className="metro-brand-panel">
              {/* 移动端汉堡按钮：仅 ≤768px 通过 CSS 显示，点击切换抽屉式侧栏 */}
              <button
                type="button"
                className="metro-mobile-toggle"
                aria-label={isMobileSidebarOpen ? '关闭线路列表' : '打开线路列表'}
                aria-expanded={isMobileSidebarOpen}
                aria-controls="metro-line-sidebar"
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
              <Tooltip title={currentMap ? '点击重命名当前方案' : localProject?.filePath ? `本机工程：${localProject.filePath}（点击另存为）` : '点击保存方案'}>
                <button
                  type="button"
                  className="metro-header-mapchip"
                  onClick={handleClickMapNameChip}
                >
                  <EditOutlined className="metro-header-mapchip__icon" />
                  <span className="metro-header-mapchip__name">{mapDisplayName}</span>
                  {localProject?.filePath ? (
                    <span className="metro-header-mapchip__tag">{language === 'en-US' ? 'Local' : '本机'}</span>
                  ) : null}
                </button>
              </Tooltip>
              {!isOnline ? (
                <span className="metro-header-offline-pill" title="当前无网络连接，纯画布绘图、本地工程读写与图片/MP4 导出均可正常离线使用">
                  {language === 'en-US' ? 'Offline' : '离线可用'}
                </span>
              ) : null}
            </section>

            <section className={`metro-toolbar-panel${isMobileSidebarOpen ? ' is-mobile-obscured' : ''}`}>
              <Toolbar
                language={language}
                onExportImage={handleExportImage}
                onExportSvg={handleExportSvg}
                onOpenVideoModal={() => (userProfile || isDesktopClient || hasDesktopBridge()) ? setVideoModalOpen(true) : requestGuestAuth('video')}
                onOpenGallery={openGallery}
                onUndo={handleUndo}
                onRedo={handleRedo}
                canUndo={canUndo}
                canRedo={canRedo}
                mobileViewControlsRef={setMobileViewControlsHost}
              />
            </section>

            <section className="metro-user-panel">
              {/* AI 助手按钮：32px 同色系极光环，与顶栏控件齐高 */}
              <Tooltip title={!isOnline ? '离线状态：联网后可使用 AI 助手' : 'AI 助手 —— 用自然语言编辑线路图'}>
                <button
                  type="button"
                  className="metro-header-ai-btn"
                  aria-label="打开 AI 助手"
                  onClick={() => {
                    if (!isOnline) {
                      message.info('当前处于离线状态，联网后可使用 AI 线网助手');
                      return;
                    }
                    if (userProfile || hasActiveCustomAiKey()) setAiModalOpen(true);
                    else requestGuestAuth('ai');
                  }}
                >
                  <span className="metro-header-ai-btn__icon">
                    <ThunderboltOutlined />
                  </span>
                </button>
              </Tooltip>
              {(() => {
                const isCleanSaved = Boolean(
                  ((userProfile && currentMap) || localProject?.filePath) && !dirty && !saveMapSaving
                );
                const saveLabel = isCleanSaved ? text.savedState : text.saveMap;
                return (
                  <Tooltip title={isCleanSaved ? (language === 'en-US' ? 'All changes saved · Click map name to rename' : '所有更改已保存 · 点击左上角方案名可重命名') : undefined}>
                    <Button
                      type={isCleanSaved ? 'default' : 'primary'}
                      className={`metro-header-save-btn${isCleanSaved ? ' is-clean' : ''}`}
                      aria-label={saveLabel}
                      icon={isCleanSaved ? <CheckOutlined /> : <SaveOutlined />}
                      loading={saveMapSaving}
                      onClick={handleOpenSaveMap}
                    >
                      <span className="metro-header-save-btn__label">{saveLabel}</span>
                      {dirty ? (
                        <span
                          title="有未保存的修改"
                          className="metro-header-save-btn__dot"
                        />
                      ) : null}
                    </Button>
                  </Tooltip>
                );
              })()}

              <Dropdown menu={{ items: userMenuItems }} overlayClassName="metro-user-dropdown" trigger={['click']} placement="bottomRight">
                {isSignedInView ? (
                  <button type="button" className="user-chip user-chip--trigger">
                    <Avatar size={24} src={userProfile?.avatar || undefined} style={{ backgroundColor: 'var(--color-primary-600)' }}>
                      {userProfile?.avatar ? null : displayInitial}
                    </Avatar>
                    <span className="user-chip__name">{displayName}</span>
                    <DownOutlined className="user-chip__chevron" />
                  </button>
                ) : (
                  <button type="button" className="user-chip user-chip--trigger user-chip--guest">
                    <span className="user-chip__guest-badge" aria-hidden="true">
                      <UserOutlined />
                    </span>
                    <span className="user-chip__name">{language === 'en-US' ? 'Guest' : '访客模式'}</span>
                    <DownOutlined className="user-chip__chevron" />
                  </button>
                )}
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
            id="metro-line-sidebar"
            className={`metro-sider${isMobileSidebarOpen ? ' is-mobile-open' : ''}`}
            width={252}
          >
            <Sidebar
              language={language}
              createLineRequest={createLineRequest}
              lines={lines}
              stations={stations}
              currentLineId={currentLineId}
              onSelectLine={handleSidebarSelectLine}
              onDeselectLine={handleDeselectLine}
              onAddLine={handleSidebarAddLine}
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

              {(!previewMode || guestReady) ? <Canvas
                documentKey={currentMap?.id || localProject?.id || guestDraftId || 'draft'}
                isDocumentLoading={isMapOpening}
                initialViewport={guestInitialViewport}
                fitOnMount={!guestInitialViewport}
                onViewportChange={setGuestViewport}
                onRequireAuth={() => requestGuestAuth('ai')}
                isGuest={!isSignedInView}
                onCreateLine={() => {
                  setIsMobileSidebarOpen(false);
                  setCreateLineRequest((request) => request + 1);
                }}
                onStartWithLightCity={() => {
                  setIsMobileSidebarOpen(false);
                  setLightCityPickerOpen(true);
                }}
                onStartWithAmap={() => {
                  setIsMobileSidebarOpen(false);
                  handleBaseMapModeChange('amap');
                }}
                externalOpenTerrainSculptSeq={openTerrainSculptSeq}
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
                onApplyGraphTransaction={handleApplyGraphTransaction}
                onSelectLine={setCurrentLineId}
                onRemoveStationFromLine={handleRemoveStationFromLine}
                onBeginInteraction={pushHistory}
                onMapSettingsChange={(settings) => setMapSettings(normalizeMapSettings(settings))}
                onStageReady={(stage) => {
                  stageRef.current = stage;
                }}
                viewCommand={viewCmd}
                mobileViewControlsHost={mobileViewControlsHost}
              />
              : <div className="metro-guest-loading" role="status">正在打开本机草稿…</div>}
              <CommandBar onSubmit={runCommand} inputRef={commandInputRef} />
            </div>
          </Content>
        </Layout>

        <VideoExportModal
          key={currentMap?.id || localProject?.id || 'unsaved'}
          open={videoModalOpen}
          lines={lines}
          stations={stations}
          sections={sections}
          settings={mapSettings}
          defaultTitle={currentMap?.name || localProject?.name || '城市轨道线网历程'}
          config={mapSettings.videoExport}
          onChange={(config) => {
            if (JSON.stringify(mapSettingsRef.current.videoExport) === JSON.stringify(config)) return;
            pushHistory();
            setMapSettings(prev => normalizeMapSettings({ ...prev, videoExport: config }));
          }}
          onCancel={() => setVideoModalOpen(false)}
          onConfirm={handleConfirmSegments}
        />

        <AIAssistantModal
          open={aiModalOpen}
          busy={aiBusy}
          userId={userProfile?.id || null}
          mapKey={currentMap?.id || localProject?.id || guestDraftId || 'draft'}
          mapName={mapDisplayName}
          lines={lines}
          stations={stations}
          canUndo={canUndo}
          onUndo={handleUndo}
          onAnalyzeStream={handleAiAnalyzeStream}
          onApply={handleAiApply}
          onCancel={() => setAiModalOpen(false)}
        />

        <DraggableModal
          title="保存地图"
          open={saveMapVisible}
          onCancel={() => setSaveMapVisible(false)}
          onOk={handleSaveMap}
          confirmLoading={saveMapSaving}
          okText="保存"
          cancelText="取消"
          footer={
            hasDesktopBridge() ? (
              <Space>
                <Button onClick={() => setSaveMapVisible(false)}>取消</Button>
                <Button onClick={() => { void handleSaveLocalProject(true); }}>
                  保存到本机 (.metro)
                </Button>
                <Button type="primary" loading={saveMapSaving} onClick={handleSaveMap}>
                  保存到云端
                </Button>
              </Space>
            ) : undefined
          }
        >
          <Input
            value={mapName}
            onChange={(event) => setMapName(event.target.value)}
            onPressEnter={handleSaveMap}
            placeholder="请输入地图名称（留空将自动命名）"
            maxLength={40}
          />
        </DraggableModal>

        <DraggableModal
          title="我的地图"
          className="metro-gallery-maps"
          open={mapsVisible}
          onCancel={() => { setMapsVisible(false); setMapsSearchKeyword(''); }}
          footer={null}
          width={920}
        >
          <div className="metro-maps-subhead">
            <span>私人存档与已发布的广场作品独立存储，互不影响</span>
            <Button type="link" size="small" onClick={()=>{setMapsVisible(false);navigatePublic("/gallery?view=mine");}}>管理广场作品 →</Button>
          </div>
          {(() => {
            const publishedIds = new Set(myPublications.map((w) => w.sourceMapId));
            const publicCount = savedMaps.filter((m) => publishedIds.has(m.id)).length;
            const privateCount = savedMaps.length - publicCount;
            const filterItems = [
              { key: 'all', label: '全部', count: savedMaps.length },
              { key: 'private', label: '私人存档', count: privateCount },
              { key: 'public', label: '广场作品', count: publicCount }
            ];
            return (
              <div className="metro-maps-toolbar">
                <ElasticCapsuleTabs
                  ariaLabel="地图类型筛选"
                  value={mapsPublicationFilter}
                  onChange={setMapsPublicationFilter}
                  options={filterItems.map((f) => ({
                    value: f.key,
                    label: (
                      <>
                        <span>{f.label}</span>
                        <span className="metro-elastic-tabs__badge">{f.count}</span>
                      </>
                    )
                  }))}
                />
                <Input.Search
                  allowClear
                  className="metro-maps-search"
                  placeholder="搜索地图名称…"
                  value={mapsSearchKeyword}
                  onChange={(event) => setMapsSearchKeyword(event.target.value)}
                />
              </div>
            );
          })()}
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
            pagination={{pageSize:6,showSizeChanger:false,hideOnSinglePage:true}}
            dataSource={savedMaps.filter(item=>mapsPublicationFilter==="all"||(mapsPublicationFilter==="public"?myPublications.some(w=>w.sourceMapId===item.id):!myPublications.some(w=>w.sourceMapId===item.id))).filter((item) =>
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
              const publication = myPublications.find(w=>w.sourceMapId===item.id);
              const counts = [
                { label: '线路', value: item.lineCount },
                { label: '站点', value: item.stationCount },
                { label: '区间', value: item.sectionCount }
              ].filter((c) => typeof c.value === 'number');
              return (
                <List.Item
                  actions={[
                    <Button key="publish" type="link" onClick={()=>{const work=myPublications.find(w=>w.sourceMapId===item.id);setMapsVisible(false);setPublishSource({id:item.id,name:item.name,work});}}>{myPublications.some(w=>w.sourceMapId===item.id)?'更新发布':'发布到广场'}</Button>,
                    <Button key="load" onClick={() => handleLoadMap(item.id)}>打开</Button>,
                    <Dropdown key="more" menu={{items:[
                      {key:'rename',label:'重命名',onClick:()=>openRenameMapModal(item)},
                      {key:'duplicate',label:duplicatingMapId===item.id?'正在复制…':'复制地图',disabled:!!duplicatingMapId,onClick:()=>void handleDuplicateMap(item.id)},
                      {key:'delete',label:'删除私人地图',danger:true,onClick:()=>Modal.confirm({title:'删除这份私人地图？',content:publication?'该地图的公开副本继续保留，可前往我的作品撤回。':'请先保留需要的备份。',okText:'删除',cancelText:'取消',okButtonProps:{danger:true},onOk:()=>handleDeleteMap(item.id)})}
                    ]}}><Button aria-label="更多地图操作" icon={<MoreOutlined/>}/></Dropdown>
                  ]}
                >
                  <List.Item.Meta
                    avatar={<PrivateMapThumbnail map={item}/>}
                    title={
                      <Space size={8} wrap>
                        <span>{item.name}</span>
                        <span className={`gallery-status gallery-status--${publication?.reviewStatus||'private'}`}>{publication?publication.reviewStatus==='pending'?'审核中':publication.reviewStatus==='returned'?'待修改':publication.visibility==='public'?'已发布':publication.visibility==='hidden'?'已隐藏':'已撤回':'私人存档'}</span>
                        {isCurrent ? (
                          <span
                            style={{
                              fontSize: 11,
                              padding: '0 8px',
                              borderRadius: 10,
                              background: 'rgba(74,107,140,0.14)',
                              color: 'var(--color-primary-600, #2563eb)',
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
                              <span key={c.label} style={{ color: 'var(--color-text-soft, #6b6157)' }}>
                                {c.label}{' '}
                                <strong style={{ color: 'var(--color-text, #2a2520)', fontWeight: 600 }}>{c.value}</strong>
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
          <div className="gallery-private-footer"><span>共 {savedMaps.length} 份私人地图</span><Button onClick={()=>{setMapsVisible(false);handleNewMap();}} icon={<FileAddOutlined/>}>新建空白方案</Button></div>
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

        {baseMapPickerStyle !== null && <BaseMapPicker initialStyle={baseMapPickerStyle} language={language} hasContent={stations.length > 0 || sections.length > 0}
          onCancel={() => setBaseMapPickerStyle(null)} onConfirm={(style) => {
            pushHistory();
            setCurrentLineId(null);
            setMapSettings(prev => normalizeMapSettings({ ...prev, baseMap: {
              ...prev.baseMap, mode: 'amap', amap: { ...(prev.baseMap.amap || DEFAULT_MAP_SETTINGS.baseMap.amap!), style }
            } }));
            try { localStorage.setItem('metro_amap_style', style); } catch { /* The selected map still works for this session. */ }
            setBaseMapPickerStyle(null);
            setSettingsVisible(false);
          }} />}

        <LightCityPickerModal
          open={lightCityPickerOpen}
          initialArchetype={mapSettings.baseMap.lightCity?.archetype || 'river'}
          initialSeed={mapSettings.baseMap.lightCity?.seed}
          isDark={mapSettings.canvasTheme === 'dark'}
          language={language}
          onCancel={() => setLightCityPickerOpen(false)}
          onConfirm={(archetype: LightCityArchetype, seed: number, openSculptImmediately: boolean) => {
            pushHistory();
            const generated = generateLightCity({ archetype, seed, stations, language });
            setMapSettings((prev) =>
              normalizeMapSettings({
                ...prev,
                baseMap: {
                  ...prev.baseMap,
                  mode: 'light-city',
                  lightCity: {
                    ...generated,
                    opacity: prev.baseMap.lightCity?.opacity ?? 1,
                    layerVisibility: prev.baseMap.lightCity?.layerVisibility || generated.layerVisibility
                  }
                }
              })
            );
            setLightCityPickerOpen(false);
            setSettingsVisible(false);
            if (openSculptImmediately) {
              setOpenTerrainSculptSeq((s) => s + 1);
            }
          }}
        />

        {aboutVisible && <AboutPanel language={language} onClose={() => setAboutVisible(false)}
          onOpenProfile={() => { setAboutVisible(false); setProfileVisible(true); }} />}

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
                      <ElasticCapsuleTabs
                        ariaLabel={text.language}
                        value={language}
                        onChange={setLanguage}
                        options={[
                          { value: 'zh-CN', label: text.simplifiedChinese },
                          { value: 'en-US', label: text.english }
                        ]}
                      />
                    </section>

                    <section className="metro-settings-section">
                      <div className="metro-settings-label">{text.interfaceTheme}</div>
                      <ElasticCapsuleTabs
                        ariaLabel={text.interfaceTheme}
                        value={interfaceTheme}
                        onChange={setInterfaceTheme}
                        options={[
                          { value: 'light', label: text.light },
                          { value: 'dark', label: text.dark },
                          { value: 'system', label: text.system }
                        ]}
                      />
                    </section>

                    <section className="metro-settings-section">
                      <div className="metro-settings-label">
                        {language === 'en-US' ? 'AI Endpoint & API Key' : 'AI 接口与自有密钥'}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                        <span style={{ fontSize: 13, color: 'var(--color-text-muted, #64748b)' }}>
                          {customAiBadge
                            ? (language === 'en-US' ? `Active: ${customAiBadge}` : `当前已启用：${customAiBadge}`)
                            : (language === 'en-US' ? 'Using platform free quota' : '当前使用平台免费通道（支持自填 DeepSeek / OpenAI 等密钥）')}
                        </span>
                        <Button size="small" onClick={() => setAiApiSettingsOpen(true)}>
                          {language === 'en-US' ? 'Configure API Key' : '配置 API Key'}
                        </Button>
                      </div>
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
                      <ElasticCapsuleTabs
                        ariaLabel={text.canvasTheme}
                        value={mapSettings.canvasTheme}
                        onChange={(next) => {
                          pushHistory();
                          setMapSettings((prev) => normalizeMapSettings({ ...prev, canvasTheme: next }));
                        }}
                        options={[
                          { value: 'light', label: text.lightCanvas },
                          { value: 'dark', label: text.darkCanvas }
                        ]}
                      />
                    </section>

                    <section className="metro-settings-section">
                      <div className="metro-settings-label">{text.cityStyle}</div>
                      <ElasticCapsuleTabs
                        ariaLabel={text.cityStyle}
                        value={mapSettings.cityStyle}
                        onChange={(next) => {
                          pushHistory();
                          setMapSettings((prev) => normalizeMapSettings({ ...prev, cityStyle: next }));
                        }}
                        options={[
                          { value: 'standard', label: text.cityStyleStandard },
                          { value: 'beijing', label: text.cityStyleBeijing },
                          { value: 'shanghai', label: text.cityStyleShanghai },
                          { value: 'mtr', label: text.cityStyleMtr }
                        ]}
                      />
                    </section>

                    <section className="metro-settings-section">
                      <div className="metro-settings-label">{text.showLineNameLabels}</div>
                      <ElasticCapsuleTabs
                        ariaLabel={text.showLineNameLabels}
                        value={mapSettings.showLineNameLabels ? 'show' : 'hide'}
                        onChange={(next) => {
                          pushHistory();
                          setMapSettings((prev) =>
                            normalizeMapSettings({ ...prev, showLineNameLabels: next === 'show' })
                          );
                        }}
                        options={[
                          { value: 'show', label: text.lineNameLabelsOn },
                          { value: 'hide', label: text.lineNameLabelsOff }
                        ]}
                      />
                    </section>

                    <section className="metro-settings-section">
                      <div className="metro-settings-label">{text.labelDensity}</div>
                      <ElasticCapsuleTabs
                        ariaLabel={text.labelDensity}
                        value={mapSettings.labelDensity}
                        onChange={(next) => {
                          pushHistory();
                          writeLabelDensity(next);
                          setMapSettings((prev) =>
                            normalizeMapSettings({ ...prev, labelDensity: next })
                          );
                        }}
                        options={[
                          { value: 'paper', label: text.labelDensityPaper },
                          { value: 'adaptive', label: text.labelDensityAdaptive },
                          { value: 'key', label: text.labelDensityKey }
                        ]}
                      />
                    </section>

                    <section className="metro-settings-section">
                      <div className="metro-settings-label">{text.lineCorner}</div>
                      <ElasticCapsuleTabs
                        ariaLabel={text.lineCorner}
                        value={mapSettings.cornerRadius > 0 ? 'round' : 'sharp'}
                        onChange={(next) => {
                          pushHistory();
                          const round = next === 'round';
                          setMapSettings((prev) =>
                            normalizeMapSettings({
                              ...prev,
                              cornerRadius: round ? (prev.cornerRadius > 0 ? prev.cornerRadius : 12) : 0
                            })
                          );
                        }}
                        options={[
                          { value: 'sharp', label: text.lineCornerSharp },
                          { value: 'round', label: text.lineCornerRound }
                        ]}
                      />
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

                    <section className="metro-settings-section">
                      <div className="metro-settings-label">{text.waypointVisibility}</div>
                      <ElasticCapsuleTabs<'show' | 'hide'>
                        ariaLabel={text.waypointVisibility}
                        value={mapSettings.hideWaypoints ? 'hide' : 'show'}
                        onChange={(next) => {
                          const hide = next === 'hide';
                          pushHistory();
                          writeHideWaypoints(hide);
                          setMapSettings((prev) =>
                            normalizeMapSettings({ ...prev, hideWaypoints: hide })
                          );
                        }}
                        options={[
                          { value: 'show', label: text.waypointShow },
                          { value: 'hide', label: text.waypointHide }
                        ]}
                      />
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
                      <ElasticCapsuleTabs
                        ariaLabel={text.baseMap}
                        value={mapSettings.baseMap.mode}
                        onChange={(next) => handleBaseMapModeChange(next)}
                        options={[
                          { value: 'plain', label: text.plainCanvas },
                          { value: 'light-city', label: text.lightCityBaseMap },
                          { value: 'amap', label: text.amapBaseMap }
                        ]}
                      />
                    </section>

                    {mapSettings.baseMap.mode === 'light-city' && (
                      <section className="metro-settings-section">
                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            marginBottom: 10
                          }}
                        >
                          <div className="metro-settings-label" style={{ marginBottom: 0 }}>
                            {language === 'en-US' ? 'Light City Layers & Terrain' : '轻城市地貌与图层'}
                          </div>
                          <Space size={6}>
                            <Button
                              size="small"
                              onClick={() => {
                                const cur = mapSettings.baseMap.lightCity;
                                const arch = cur?.archetype && cur.archetype !== 'custom' ? cur.archetype : 'river';
                                const fresh = generateLightCity({
                                  archetype: arch,
                                  seed: Math.floor(100000 + Math.random() * 899999),
                                  stations,
                                  language
                                });
                                pushHistory();
                                setMapSettings((prev) =>
                                  normalizeMapSettings({
                                    ...prev,
                                    baseMap: {
                                      ...prev.baseMap,
                                      mode: 'light-city',
                                      lightCity: {
                                        ...fresh,
                                        opacity: prev.baseMap.lightCity?.opacity ?? 1,
                                        layerVisibility:
                                          prev.baseMap.lightCity?.layerVisibility || fresh.layerVisibility
                                      }
                                    }
                                  })
                                );
                              }}
                            >
                              {language === 'en-US' ? 'Shuffle' : '换一座城'}
                            </Button>
                            <Button size="small" type="primary" ghost onClick={() => setLightCityPickerOpen(true)}>
                              {language === 'en-US' ? 'Templates…' : '选择地貌模板…'}
                            </Button>
                          </Space>
                        </div>

                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
                          {(
                            [
                              { key: 'zones', zh: '城区与绿地', en: 'Zones & Parks' },
                              { key: 'water', zh: '水系与洲岛', en: 'Rivers & Bays' },
                              { key: 'roads', zh: '骨干街道', en: 'Arterial Roads' },
                              { key: 'labels', zh: '片区水印名', en: 'District Labels' }
                            ] as const
                          ).map((item) => {
                            const lc =
                              mapSettings.baseMap.lightCity ||
                              generateLightCity({ archetype: 'river', stations, language });
                            const active = lc.layerVisibility[item.key];
                            return (
                              <button
                                key={item.key}
                                type="button"
                                onClick={() => {
                                  pushHistory();
                                  setMapSettings((prev) => {
                                    const baseLc =
                                      prev.baseMap.lightCity ||
                                      generateLightCity({ archetype: 'river', stations, language });
                                    return normalizeMapSettings({
                                      ...prev,
                                      baseMap: {
                                        ...prev.baseMap,
                                        mode: 'light-city',
                                        lightCity: {
                                          ...baseLc,
                                          layerVisibility: {
                                            ...baseLc.layerVisibility,
                                            [item.key]: !baseLc.layerVisibility[item.key]
                                          }
                                        }
                                      }
                                    });
                                  });
                                }}
                                style={{
                                  padding: '4px 12px',
                                  borderRadius: 999,
                                  fontSize: 12.5,
                                  fontWeight: 600,
                                  cursor: 'pointer',
                                  border: active ? '1px solid #2563eb' : '1px solid var(--color-border, #cbd5e1)',
                                  background: active ? 'rgba(37, 99, 235, 0.10)' : 'transparent',
                                  color: active ? '#2563eb' : 'var(--color-text-muted, #64748b)'
                                }}
                              >
                                {active ? '✓ ' : ''}
                                {language === 'en-US' ? item.en : item.zh}
                              </button>
                            );
                          })}
                        </div>

                        <div className="metro-settings-control">
                          <div className="metro-settings-control__row">
                            <span>{language === 'en-US' ? 'Basemap Opacity' : '底图克制浓度'}</span>
                            <strong>{Math.round((mapSettings.baseMap.lightCity?.opacity ?? 1) * 100)}%</strong>
                          </div>
                          <Slider
                            min={30}
                            max={100}
                            step={5}
                            value={Math.round((mapSettings.baseMap.lightCity?.opacity ?? 1) * 100)}
                            onChange={(val) => {
                              beginSettingsInteraction();
                              setMapSettings((prev) => {
                                const baseLc =
                                  prev.baseMap.lightCity ||
                                  generateLightCity({ archetype: 'river', stations, language });
                                return normalizeMapSettings({
                                  ...prev,
                                  baseMap: {
                                    ...prev.baseMap,
                                    mode: 'light-city',
                                    lightCity: {
                                      ...baseLc,
                                      opacity: val / 100
                                    }
                                  }
                                });
                              });
                            }}
                            onChangeComplete={endSettingsInteraction}
                          />
                        </div>
                      </section>
                    )}

                    {mapSettings.baseMap.mode === 'amap' && (
                      <section className="metro-settings-section">
                        <div className="metro-settings-label">{text.amapStyle}</div>
                        <ElasticCapsuleTabs
                          ariaLabel={text.amapStyle}
                          value={mapSettings.baseMap.amap?.style || 'normal'}
                          onChange={(next) => {
                            pushHistory();
                            setMapSettings((prev) =>
                              normalizeMapSettings({
                                ...prev,
                                baseMap: {
                                  mode: 'amap',
                                  amap: {
                                    ...(prev.baseMap.amap || DEFAULT_MAP_SETTINGS.baseMap.amap!),
                                    style: next
                                  }
                                }
                              })
                            );
                            try { localStorage.setItem('metro_amap_style', next); } catch { /* Keep the selection in the current map. */ }
                          }}
                          options={[
                            { value: 'normal', label: text.amapNormal },
                            { value: 'dark', label: text.amapDark },
                            { value: 'grey', label: text.amapGrey },
                            { value: 'fresh', label: text.amapFresh }
                          ]}
                        />
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
        <AIApiSettingsModal open={aiApiSettingsOpen} onClose={() => setAiApiSettingsOpen(false)} />

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
              src={userProfile?.avatar || undefined}
              className="metro-profile-identity__avatar"
              onClick={() => avatarInputRef.current?.click()}
            >
              {userProfile?.avatar ? null : displayInitial}
            </Avatar>
            <div className="metro-profile-identity__main">
              <div className="metro-profile-identity__name">{displayName}</div>
              <div className="metro-profile-identity__phone">
                {userProfile?.email || (userProfile?.phone ? `+86 ${userProfile?.phone}` : '')}
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
              username: userProfile?.username,
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
              {userProfile?.email ? (
                <div className="metro-profile-field">
                  <div className="metro-profile-field__label">{text.email}</div>
                  <div className="metro-profile-field__value">
                    <span>{userProfile?.email}</span>
                    <span
                      className="metro-profile-field__badge"
                      style={userProfile?.emailVerified ? undefined : { color: 'var(--color-warning, #d97706)' }}
                    >
                      <span className="metro-profile-field__badge-dot" />
                      {userProfile?.emailVerified ? text.emailVerified : text.emailUnverified}
                    </span>
                  </div>
                </div>
              ) : userProfile?.phone ? (
                <div className="metro-profile-field">
                  <div className="metro-profile-field__label">{text.phone}</div>
                  <div className="metro-profile-field__value">
                    <span>+86 {userProfile?.phone}</span>
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

            <p className="metro-about__foot">{language === 'en-US' ? 'For account deletion or data requests, contact us using your registered email: ' : '账号注销、数据导出或删除申请，请通过注册邮箱联系：'}
              <a href="mailto:3855166698@qq.com?subject=Metro%20Designer%20账号与数据申请">3855166698@qq.com</a>
            </p>
            <div className="metro-profile-actions">
              <Button onClick={() => setProfileVisible(false)}>{text.profileCancel}</Button>
              <Button type="primary" htmlType="submit">
                {text.profileSave}
              </Button>
            </div>
          </Form>
        </DraggableModal>

        <DraggableModal title="导出视频" open={isExporting} footer={null} closable={false} maskClosable={false} keyboard={false} centered>
          <Space direction="vertical" style={{ width: '100%' }} size="middle">
            <div aria-live="polite" style={{ fontWeight: 500 }}>
              {videoProgress.phase === 'preparing' ? (videoProgress.detail || '正在准备线路与底图…') :
                videoProgress.phase === 'paused' ? '录制已暂停，返回此页面后自动继续' :
                videoProgress.phase === 'finalizing' ? (videoProgress.detail || '正在封装视频文件…') :
                (videoProgress.detail || '正在编码视频画面…')}
            </div>
            <Progress percent={videoProgress.percent} status={videoProgress.phase === 'paused' ? 'normal' : 'active'} />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--color-text-muted)', fontVariantNumeric: 'tabular-nums' }}>
              <span>
                {videoProgress.mode === 'webcodecs-mp4'
                  ? '离线 MP4 编码（切换窗口不中断）'
                  : videoProgress.totalSec > 0
                    ? `已处理 ${Math.floor(videoProgress.elapsedSec)} 秒 / 共 ${Math.ceil(videoProgress.totalSec)} 秒`
                    : '准备中…'}
              </span>
              {typeof videoProgress.etaSec === 'number' && videoProgress.etaSec > 0.4 ? (
                <span>预计剩余 {Math.ceil(videoProgress.etaSec)} 秒</span>
              ) : null}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Button onClick={() => videoAbortRef.current?.abort()}>取消导出</Button>
            </div>
          </Space>
        </DraggableModal>

        <DraggableModal
          title={`视频已生成（${exportedVideo?.format || 'MP4'}）`}
          open={Boolean(exportedVideo)}
          onCancel={closeExportedVideoPreview}
          footer={null}
          width={680}
          centered
        >
          {exportedVideo ? (
            <Space direction="vertical" style={{ width: '100%' }} size="middle">
              <div className="metro-video-result-box">
                <video src={exportedVideo.url} controls autoPlay loop muted playsInline />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                <span style={{ fontSize: 12.5, color: 'var(--color-text-muted)' }}>
                  若浏览器拦截了自动下载，可点击右侧按钮手动保存
                </span>
                <Space>
                  <Button
                    onClick={() => {
                      closeExportedVideoPreview();
                      setVideoModalOpen(true);
                    }}
                  >
                    返回调整参数
                  </Button>
                  <Button
                    type="primary"
                    onClick={async () => {
                      if (hasDesktopBridge()) {
                        const blob = await (await fetch(exportedVideo.url)).blob();
                        const saved = await saveDesktopExport(blob, exportedVideo.filename);
                        if (saved) message.success('视频已保存到本机');
                        return;
                      }
                      const a = document.createElement('a');
                      a.href = exportedVideo.url;
                      a.download = exportedVideo.filename;
                      document.body.appendChild(a);
                      a.click();
                      a.remove();
                    }}
                  >
                    下载 {exportedVideo.format} 视频
                  </Button>
                </Space>
              </div>
            </Space>
          ) : null}
        </DraggableModal>
      </Layout>
    </div>
      </AntdApp>
    </ConfigProvider>
  );
};

export default App;
