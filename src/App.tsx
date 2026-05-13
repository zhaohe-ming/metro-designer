import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Avatar, Button, ColorPicker, ConfigProvider, Divider, Form, Input, Layout, List, Modal, Popconfirm, Radio, Slider, Space, App as AntdApp, message, theme as antdTheme } from 'antd';
import { api, clearToken, getToken, setToken } from './api';
import { createId } from './utils/id';
import AuthPanel from './components/AuthPanel';
import Canvas from './components/Canvas';
import DraggableModal from './components/DraggableModal';
import Sidebar from './components/Sidebar';
import Toolbar from './components/Toolbar';
import VideoExportModal, { VideoSegmentInput } from './components/VideoExportModal';
import { BaseMapMode, DEFAULT_MAP_SETTINGS, Line, MapSettings, Section, Station, normalizeMapSettings, normalizeSections } from './types';
import { exportVideoFromStage } from './lib/exportVideo';
import { compressImageDataUrl } from './utils/imageCompress';

// 头像 dataURL 体积阈值：超过即认为是"需要压缩的大头像"。
// 后端 PUT /api/me 给的硬上限是 200_000；这里取 60KB 作为"还能再瘦一点"的软阈值。
const AVATAR_COMPRESS_THRESHOLD = 60_000;

const MAX_HISTORY = 50;
const LAST_MAP_KEY = 'metro_last_map_id';
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
  phone: string;
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
    cityStyle: '城市风格',
    cityStyleStandard: '通用专业',
    cityStyleBeijing: '北京',
    cityStyleShanghai: '上海',
    cityStyleMtr: '港铁',
    showLineNameLabels: '显示线路名称标注',
    lineNameLabelsOn: '显示',
    lineNameLabelsOff: '隐藏',
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
    avatarHint: '点击头像可上传本机图片'
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
    cityStyle: 'City style',
    cityStyleStandard: 'Standard',
    cityStyleBeijing: 'Beijing',
    cityStyleShanghai: 'Shanghai',
    cityStyleMtr: 'MTR',
    showLineNameLabels: 'Line name labels',
    lineNameLabelsOn: 'Show',
    lineNameLabelsOff: 'Hide',
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
    avatarHint: 'Click avatar to upload an image'
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
  const [mapSettings, setMapSettings] = useState<MapSettings>(DEFAULT_MAP_SETTINGS);
  const [past, setPast] = useState<DocSnapshot[]>([]);
  const [future, setFuture] = useState<DocSnapshot[]>([]);
  const isApplyingHistoryRef = useRef(false);
  const linesRef = useRef(lines);
  const sectionsRef = useRef(sections);
  const stationsRef = useRef(stations);
  const mapSettingsRef = useRef(mapSettings);
  useEffect(() => { linesRef.current = lines; }, [lines]);
  useEffect(() => { sectionsRef.current = sections; }, [sections]);
  useEffect(() => { stationsRef.current = stations; }, [stations]);
  useEffect(() => { mapSettingsRef.current = mapSettings; }, [mapSettings]);

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
  }, []);

  const resetHistory = useCallback(() => {
    setPast([]);
    setFuture([]);
  }, []);

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
      return prevPast.slice(0, -1);
    });
  }, []);

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
      return prevFuture.slice(1);
    });
  }, []);

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
    setLines((prev) =>
      prev.map((line) => {
        const nextSectionIds = line.sectionIds.filter((sectionId) => {
          const currentSection = sections.find((section) => section.id === sectionId);
          if (!currentSection) return false;
          return currentSection.startStationId !== stationId && currentSection.endStationId !== stationId;
        });

        return {
          ...line,
          stationIds: line.stationIds.filter((id) => id !== stationId),
          sectionIds: nextSectionIds,
          lastAddedStationId: line.lastAddedStationId === stationId ? undefined : line.lastAddedStationId
        };
      })
    );
    setSections((prev) => prev.filter((section) => section.startStationId !== stationId && section.endStationId !== stationId));
    setStations((prev) => prev.filter((station) => station.id !== stationId));
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

  const handleLogin = async ({ phone, password }: { phone: string; password: string }) => {
    try {
      const { token, user } = await api.login({ phone, password });
      setToken(token);
      setUserProfile({ ...user, password: '' });
      refreshSavedMaps(false);
      message.success('登录成功');
    } catch (error: any) {
      message.error(error.message || '登录失败');
    }
  };

  const handleRegister = async ({
    phone,
    username,
    password
  }: {
    phone: string;
    username: string;
    password: string;
  }) => {
    try {
      const { token, user } = await api.register({ phone, username, password });
      setToken(token);
      setUserProfile({ ...user, password: '' });
      refreshSavedMaps(false);
      message.success('注册成功，已自动登录');
    } catch (error: any) {
      message.error(error.message || '注册失败');
    }
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

  const handleUpdateProfile = async (values: {
    username: string;
    avatar?: string;
    password?: string;
    confirm?: string;
  }) => {
    if (!userProfile) return;

    try {
      const avatarInput = values.avatar?.trim();
      const nextPassword =
        values.password && values.confirm && values.password === values.confirm ? values.password : undefined;
      const payload = {
        username: values.username || userProfile.username,
        avatar: avatarInput !== undefined ? avatarInput : userProfile.avatar || '',
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
        message.success({ content: '地图已覆盖保存', key: 'save-map' });
        return;
      }

      const { map } = await api.createMap({ name, lines, stations, sections, mapSettings });
      setCurrentMap({ ...map, ...counts });
      upsertSavedMap({ ...map, ...counts });
      setMapName('');
      try { localStorage.setItem(LAST_MAP_KEY, map.id); } catch { /* ignore */ }
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

  const handleConfirmSegments = async (segments: VideoSegmentInput[]) => {
    if (!stageRef.current) {
      message.error('画布尚未准备好');
      return;
    }

    setVideoModalOpen(false);
    setIsExporting(true);

    try {
      const blob = await exportVideoFromStage({
        stage: stageRef.current,
        segments,
        lines,
        stations,
        sections,
        settings: mapSettings,
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
  const displayInitial = (userProfile?.username || userProfile?.phone || 'M').charAt(0).toUpperCase();
  const activeLine = lines.find((line) => line.id === currentLineId) || null;
  const mapDisplayName = currentMap?.name || text.unnamedMap;
  const mapMetaText = currentMap
    ? `最近更新 ${new Date(currentMap.updatedAt).toLocaleString()}`
    : '从左侧组织线路，在画布上构建你的轨道图';
  const activeLineStationCount = activeLine?.stationIds.length || 0;
  const activeLineSectionCount = activeLine?.sectionIds.length || 0;

  const antdThemeConfig = useMemo(
    () => ({
      algorithm: resolvedInterfaceTheme === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
      token: {
        colorPrimary: '#2563eb',
        borderRadius: 8
      }
    }),
    [resolvedInterfaceTheme]
  );

  if (!userProfile) {
    return (
      <ConfigProvider theme={antdThemeConfig}>
        <AntdApp className="metro-antd-root" data-interface-theme={resolvedInterfaceTheme}>
          <div className="auth-layout" data-interface-theme={resolvedInterfaceTheme}>
            <AuthPanel onLogin={handleLogin} onRegister={handleRegister} />
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
              <div className="metro-brand-mark">
                <span className="metro-brand-mark__dot" />
                <div>
                  <div className="metro-brand-title">Metro Designer</div>
                  <div className="metro-brand-subtitle">Urban Transit Studio</div>
                </div>
              </div>
              <div className="metro-brand-mapname">{mapDisplayName}</div>
              <div className="metro-brand-meta">
                {mapMetaText}
                {activeLine ? ` · 当前线路 ${activeLine.name}` : ''}
              </div>
            </section>

            <section className="metro-toolbar-panel">
              <Toolbar
                language={language}
                lines={lines}
                currentLineId={currentLineId}
                onAddLine={handleAddLine}
                onSelectLine={handleSelectLine}
                onExportImage={handleExportImage}
                onOpenVideoModal={() => setVideoModalOpen(true)}
                onUndo={handleUndo}
                onRedo={handleRedo}
                canUndo={canUndo}
                canRedo={canRedo}
              />
            </section>

            <section className="metro-user-panel">
              <div className="metro-action-buttons">
                <Button className="metro-action-btn metro-action-btn--primary" size="small" loading={saveMapSaving} onClick={handleOpenSaveMap}>
                  {currentMap ? text.overwriteSave : text.saveMap}
                </Button>
                <Button className="metro-action-btn" size="small" loading={mapsLoading} onClick={handleOpenMapList}>
                  {text.viewMaps}
                </Button>
                <Button className="metro-action-btn" size="small" onClick={() => setProfileVisible(true)}>
                  {text.profile}
                </Button>
                <Button className="metro-action-btn" size="small" onClick={() => setSettingsVisible(true)}>
                  {text.settings}
                </Button>
              </div>

              <div className="user-chip">
                <Avatar size={30} src={userProfile.avatar} style={{ backgroundColor: '#4b6b95' }}>
                  {userProfile.avatar ? null : displayInitial}
                </Avatar>
                <div className="user-chip__meta">
                  <div className="user-chip__name">{displayName}</div>
                  <div className="user-chip__email">+86 {userProfile.phone}</div>
                </div>
              </div>
            </section>
          </div>
        </Header>

        <Layout className="metro-body">
          <Sider className="metro-sider" width={252}>
            <Sidebar
              language={language}
              lines={lines}
              stations={stations}
              currentLineId={currentLineId}
              onSelectLine={handleSelectLine}
              onDeselectLine={handleDeselectLine}
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
              <div className="metro-canvas-overlay">
                <div className="metro-canvas-overlay__eyebrow">Live Canvas</div>
                <div className="metro-canvas-overlay__title">城市轨道设计台</div>
                <div className="metro-canvas-overlay__text">
                  在主画布中添加站点、连接区间并调整线路结构。当前方案会围绕所选线路高亮显示。
                </div>
                <div className="metro-canvas-overlay__stats">
                  <span className="metro-stat-chip">{lines.length} 条线路</span>
                  <span className="metro-stat-chip">{stations.length} 个站点</span>
                  <span className="metro-stat-chip">{sections.length} 个区间</span>
                </div>
              </div>

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
              />
            </div>
          </Content>

          <aside className="metro-info-panel">
            <section className="metro-info-section">
              <div className="metro-info-section__label">Project</div>
              <div className="metro-info-section__value">{mapDisplayName}</div>
              <div className="metro-info-section__text">{mapMetaText}</div>
            </section>

            <section className="metro-info-section">
              <div className="metro-info-section__label">Current Line</div>
              <div className="metro-info-section__value">{activeLine?.name || '未选择线路'}</div>
              <div className="metro-info-stats">
                <div className="metro-info-stat">
                  <span>Lines</span>
                  <strong>{lines.length}</strong>
                </div>
                <div className="metro-info-stat">
                  <span>Stations</span>
                  <strong>{stations.length}</strong>
                </div>
                <div className="metro-info-stat">
                  <span>Sections</span>
                  <strong>{sections.length}</strong>
                </div>
                <div className="metro-info-stat">
                  <span>Active</span>
                  <strong>{activeLineStationCount}/{activeLineSectionCount}</strong>
                </div>
              </div>
            </section>

            <section className="metro-info-section">
              <div className="metro-info-section__label">Actions</div>
              <div className="metro-info-actions">
                <Button className="metro-info-action metro-info-action--primary" size="small" loading={saveMapSaving} onClick={handleOpenSaveMap}>
                  {currentMap ? '覆盖保存' : '保存地图'}
                </Button>
                <Button className="metro-info-action" size="small" loading={mapsLoading} onClick={handleOpenMapList}>
                  查看地图
                </Button>
              </div>
            </section>
          </aside>
        </Layout>

        <VideoExportModal
          open={videoModalOpen}
          lines={lines}
          stations={stations}
          onCancel={() => setVideoModalOpen(false)}
          onConfirm={handleConfirmSegments}
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
          <List
            loading={mapsLoading}
            dataSource={savedMaps.filter((item) =>
              mapsSearchKeyword.trim()
                ? item.name.toLowerCase().includes(mapsSearchKeyword.trim().toLowerCase())
                : true
            )}
            locale={{
              emptyText: mapsLoading
                ? '正在加载地图...'
                : mapsSearchKeyword.trim()
                  ? `没有匹配 “${mapsSearchKeyword.trim()}” 的地图`
                  : '暂无已保存地图'
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

            <div className="metro-settings-footer">
              <Button onClick={() => setSettingsVisible(false)}>{text.close}</Button>
            </div>
          </div>
        </DraggableModal>

        <DraggableModal title={text.profile} open={profileVisible} onCancel={() => setProfileVisible(false)} footer={null}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
            <Avatar
              size={56}
              src={userProfile.avatar}
              style={{ backgroundColor: '#1890ff', cursor: 'pointer' }}
              onClick={() => avatarInputRef.current?.click()}
            >
              {userProfile.avatar ? null : displayInitial}
            </Avatar>
            <div>
              <div style={{ fontWeight: 600, fontSize: 16 }}>{displayName}</div>
              <div style={{ color: '#8c8c8c' }}>{text.phone}: +86 {userProfile.phone}</div>
              <div style={{ color: '#8c8c8c', fontSize: 12 }}>{text.avatarHint}</div>
            </div>
          </div>

          <input
            ref={avatarInputRef}
            type="file"
            accept="image/*"
            onChange={handleProfileAvatarUpload}
            style={{ display: 'none' }}
          />

          <Divider style={{ margin: '12px 0' }} />

          <Form
            layout="vertical"
            autoComplete="off"
            initialValues={{
              username: userProfile.username,
              avatar: userProfile.avatar,
              password: '',
              confirm: ''
            }}
            onFinish={handleUpdateProfile}
          >
            <Form.Item label="用户名" name="username" rules={[{ required: true, message: '请输入用户名' }]}>
              <Input placeholder="更新你的用户名" maxLength={16} />
            </Form.Item>
            <Form.Item
              label="头像地址（可选）"
              name="avatar"
              extra="支持粘贴图片链接，留空则使用首字母头像"
            >
              <Input placeholder="https://example.com/avatar.png" />
            </Form.Item>
            <Form.Item label="手机号">
              <Input value={userProfile.phone} disabled />
            </Form.Item>
            <Form.Item label="新密码（可选）" name="password" rules={[{ min: 6, message: '密码长度至少 6 位' }]}>
              <Input.Password placeholder="不修改可留空" autoComplete="new-password" />
            </Form.Item>
            <Form.Item
              label="确认新密码"
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
                      return Promise.reject(new Error('请再次输入新密码'));
                    }
                    if (password === value) {
                      return Promise.resolve();
                    }
                    return Promise.reject(new Error('两次输入的密码不一致'));
                  }
                })
              ]}
            >
              <Input.Password placeholder="请再次输入新密码" autoComplete="new-password" />
            </Form.Item>
            <Form.Item>
              <Space style={{ width: '100%', justifyContent: 'flex-end' }}>
                <Button onClick={() => setProfileVisible(false)}>取消</Button>
                <Button type="primary" htmlType="submit">
                  保存
                </Button>
              </Space>
            </Form.Item>
          </Form>
          <Divider style={{ margin: '12px 0' }} />
          <Button danger type="primary" block onClick={handleLogout}>
            {text.signOut}
          </Button>
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
