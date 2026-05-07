import React, { useEffect, useRef, useState } from 'react';
import { Avatar, Button, ColorPicker, Divider, Form, Input, Layout, List, Popconfirm, Radio, Slider, Space, message } from 'antd';
import { api, clearToken, getToken, setToken } from './api';
import AuthPanel from './components/AuthPanel';
import Canvas from './components/Canvas';
import DraggableModal from './components/DraggableModal';
import Sidebar from './components/Sidebar';
import Toolbar from './components/Toolbar';
import VideoExportModal, { VideoSegmentInput } from './components/VideoExportModal';
import { getCityStylePreset } from './stylePresets';
import { DEFAULT_MAP_SETTINGS, Line, MapSettings, Section, Station, normalizeMapSettings } from './types';

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
  const [videoModalOpen, setVideoModalOpen] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [mapName, setMapName] = useState('');
  const [savedMaps, setSavedMaps] = useState<MapSummaryState[]>([]);
  const [currentMap, setCurrentMap] = useState<MapSummaryState | null>(null);
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [language, setLanguage] = useState<AppLanguage>(getInitialLanguage);
  const [interfaceTheme, setInterfaceTheme] = useState<InterfaceTheme>(getInitialInterfaceTheme);
  const [systemTheme, setSystemTheme] = useState<'light' | 'dark'>(getSystemTheme);
  const [mapSettings, setMapSettings] = useState<MapSettings>(DEFAULT_MAP_SETTINGS);
  const stageRef = useRef<any>(null);
  const avatarInputRef = useRef<HTMLInputElement | null>(null);
  const text = i18n[language];
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
      const next = prev.filter((item) => item.id !== summary.id);
      return [summary, ...next].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
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
      } catch {
        clearToken();
      }
    };
    boot();
  }, []);

  const handleAddLine = (name: string, color: string) => {
    if (lines.some((line) => line.color === color)) {
      message.error('该颜色已被其他线路占用，请选择其他颜色');
      return false;
    }

    const newLine: Line = {
      id: Date.now().toString(),
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
    setStations((prev) => [...prev, station]);
  };

  const handleUpdateStation = (updatedStation: Station) => {
    setStations((prev) => prev.map((station) => (station.id === updatedStation.id ? updatedStation : station)));
  };

  const handleRenameStation = (stationId: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) {
      message.warning('站点名称不能为空');
      return;
    }
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
        id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
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
    setLines((prev) =>
      prev.map((line) => {
        if (line.id !== lineId) return line;
        return { ...line, stationIds };
      })
    );
  };

  const handleDeleteLine = (lineId: string) => {
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

    setLines((prev) => prev.map((line) => (line.id === lineId ? { ...line, color: newColor } : line)));
    message.success('线路颜色已更新');
    return true;
  };

  const handleChangeLineName = (lineId: string, newName: string) => {
    setLines((prev) => prev.map((line) => (line.id === lineId ? { ...line, name: newName } : line)));
    message.success('线路名称已更新');
  };

  const handleDeleteStation = (stationId: string) => {
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
    message.info('已退出登录');
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
      const payload = {
        username: values.username || userProfile.username,
        avatar: avatarInput !== undefined ? avatarInput : userProfile.avatar || '',
        password: values.password || undefined
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
      const dataUrl = await fileToDataUrl(file);
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
    setMapName(currentMap?.name || '');
    setSaveMapVisible(true);
  };

  const handleSaveMap = async () => {
    try {
      const trimmed = mapName.trim();
      const fallbackName = currentMap?.name || `我的地图 ${new Date().toLocaleString()}`;
      const name = trimmed || fallbackName;

      if (currentMap) {
        const { map } = await api.updateMap(currentMap.id, { name, lines, stations, sections, mapSettings });
        setCurrentMap(map);
        upsertSavedMap(map);
        setSaveMapVisible(false);
        setMapName('');
        message.success('地图已覆盖保存');
        return;
      }

      const { map } = await api.createMap({ name, lines, stations, sections, mapSettings });
      setCurrentMap(map);
      upsertSavedMap(map);
      setSaveMapVisible(false);
      setMapName('');
      message.success('地图已保存');
    } catch (error: any) {
      message.error(error.message || '保存地图失败');
    }
  };

  const handleLoadMap = async (mapId: string) => {
    try {
      const { map } = await api.getMap(mapId);
      const loadedLines = normalizeLoadedLines(map.lines || []);

      setLines(loadedLines);
      setSections(Array.isArray(map.sections) ? map.sections : []);
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
      }

      message.success('地图已删除');
    } catch (error: any) {
      message.error(error.message || '删除地图失败');
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
      await exportVideoFromStage(stageRef.current, segments, lines, stations, sections, mapSettings);
    } catch (error: any) {
      console.error(error);
      message.error(error?.message || '导出失败，请重试');
    } finally {
      setIsExporting(false);
    }
  };

  const exportVideoFromStage = async (
    stage: any,
    segments: VideoSegmentInput[],
    allLines: Line[],
    allStations: Station[],
    allSections: Section[],
    settings: MapSettings
  ) => {
    void stage;
    if (!segments.length) {
      message.warning('请至少填写一个开通区间');
      return;
    }

    if (!allStations.length) {
      message.warning('请先创建站点后再导出视频');
      return;
    }

    const fps = 30;
    const width = 1280;
    const height = 720;
    const titleFrames = Math.round(fps * 1.2);
    const secondsPerSegment = 3;
    const segmentFrames = fps * secondsPerSegment;
    const outroFrames = fps;
    const sortedSegments = [...segments].sort((a, b) => a.openDate.localeCompare(b.openDate));
    const preset = getCityStylePreset(settings);
    const isDarkCanvas = settings.canvasTheme === 'dark';
    const mutedLineColor = isDarkCanvas ? '#334155' : '#d8e0eb';
    const mutedStationFill = isDarkCanvas ? '#0f172a' : '#ffffff';
    const mutedStationStroke = isDarkCanvas ? '#475569' : '#cbd5e1';
    const primaryText = isDarkCanvas ? '#f8fafc' : '#0f172a';
    const secondaryText = isDarkCanvas ? '#cbd5e1' : '#475569';
    const stationById = new Map(allStations.map(station => [station.id, station]));
    const stationLineCounts = allStations.reduce<Record<string, number>>((result, station) => {
      result[station.id] = allLines.filter(line => line.stationIds.includes(station.id)).length;
      return result;
    }, {});

    const resolveSegmentPath = (segment: VideoSegmentInput) => {
      const line = allLines.find(item => item.id === segment.lineId);
      const startStation = stationById.get(segment.startStationId);
      const endStation = stationById.get(segment.endStationId);
      if (!line || !startStation || !endStation || startStation.id === endStation.id) {
        throw new Error(`视频区间配置无效：${segment.openDate || '未填写日期'}`);
      }

      const startIndex = line.stationIds.indexOf(startStation.id);
      const endIndex = line.stationIds.indexOf(endStation.id);
      if (startIndex >= 0 && endIndex >= 0 && startIndex !== endIndex) {
        const orderedIds =
          startIndex < endIndex
            ? line.stationIds.slice(startIndex, endIndex + 1)
            : line.stationIds.slice(endIndex, startIndex + 1).reverse();
        if (orderedIds.every(id => stationById.has(id))) {
          return { segment, line, stationIds: orderedIds };
        }
      }

      const adjacency = new Map<string, string[]>();
      allSections
        .filter(section => section.lineId === line.id)
        .forEach(section => {
          adjacency.set(section.startStationId, [...(adjacency.get(section.startStationId) || []), section.endStationId]);
          adjacency.set(section.endStationId, [...(adjacency.get(section.endStationId) || []), section.startStationId]);
        });

      const queue: string[][] = [[startStation.id]];
      const visited = new Set([startStation.id]);
      while (queue.length) {
        const path = queue.shift()!;
        const tail = path[path.length - 1];
        if (tail === endStation.id) return { segment, line, stationIds: path };
        (adjacency.get(tail) || []).forEach(next => {
          if (!visited.has(next)) {
            visited.add(next);
            queue.push([...path, next]);
          }
        });
      }

      throw new Error(`找不到视频路径：${line.name} ${startStation.name} - ${endStation.name}`);
    };

    const animationSegments = sortedSegments.map(resolveSegmentPath);
    const minX = Math.min(...allStations.map(station => station.x));
    const minY = Math.min(...allStations.map(station => station.y));
    const maxX = Math.max(...allStations.map(station => station.x));
    const maxY = Math.max(...allStations.map(station => station.y));
    const padding = 96;
    const mapWidth = Math.max(1, maxX - minX);
    const mapHeight = Math.max(1, maxY - minY);
    const mapScale = Math.min((width - padding * 2) / mapWidth, (height - padding * 2) / mapHeight, 2.2);
    const mapOffset = {
      x: (width - mapWidth * mapScale) / 2 - minX * mapScale,
      y: (height - mapHeight * mapScale) / 2 - minY * mapScale - 10
    };
    const toCanvasPoint = (station: Station) => ({
      x: station.x * mapScale + mapOffset.x,
      y: station.y * mapScale + mapOffset.y
    });
    const pathToPoints = (stationIds: string[]) =>
      stationIds.map(id => stationById.get(id)).filter(Boolean).map(station => toCanvasPoint(station!));

    const canvasThemeGradient = (ctx: CanvasRenderingContext2D) => {
      const gradient = ctx.createLinearGradient(0, 0, width, height);
      if (isDarkCanvas) {
        gradient.addColorStop(0, '#07111f');
        gradient.addColorStop(1, '#0f172a');
      } else {
        gradient.addColorStop(0, '#fbfdff');
        gradient.addColorStop(1, '#eef6ff');
      }
      return gradient;
    };

    const roundRect = (
      ctx: CanvasRenderingContext2D,
      x: number,
      y: number,
      rectWidth: number,
      rectHeight: number,
      radius: number
    ) => {
      const r = Math.min(radius, rectWidth / 2, rectHeight / 2);
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + rectWidth - r, y);
      ctx.quadraticCurveTo(x + rectWidth, y, x + rectWidth, y + r);
      ctx.lineTo(x + rectWidth, y + rectHeight - r);
      ctx.quadraticCurveTo(x + rectWidth, y + rectHeight, x + rectWidth - r, y + rectHeight);
      ctx.lineTo(x + r, y + rectHeight);
      ctx.quadraticCurveTo(x, y + rectHeight, x, y + rectHeight - r);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.closePath();
    };

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      message.error('浏览器不支持导出视频');
      return;
    }

    const drawLinePath = (
      points: Array<{ x: number; y: number }>,
      color: string,
      progress = 1,
      alpha = 1,
      lineWidth = preset.lineWidth
    ) => {
      if (points.length < 2 || progress <= 0) return;
      const lengths = points.slice(1).map((point, index) => Math.hypot(point.x - points[index].x, point.y - points[index].y));
      const totalLength = lengths.reduce((sum, value) => sum + value, 0);
      let remaining = totalLength * Math.min(1, progress);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.shadowColor = color;
      ctx.shadowBlur = preset.lineShadowBlur;
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let index = 1; index < points.length; index += 1) {
        const previous = points[index - 1];
        const current = points[index];
        const length = lengths[index - 1];
        if (remaining >= length) {
          ctx.lineTo(current.x, current.y);
          remaining -= length;
        } else {
          const ratio = length === 0 ? 0 : remaining / length;
          ctx.lineTo(previous.x + (current.x - previous.x) * ratio, previous.y + (current.y - previous.y) * ratio);
          break;
        }
      }
      ctx.stroke();
      ctx.restore();
    };

    const drawStation = (station: Station, activeColor?: string, pulse = 0) => {
      const point = toCanvasPoint(station);
      const isInterchange = (stationLineCounts[station.id] || 0) > 1;
      const color = activeColor || mutedStationStroke;
      ctx.save();
      ctx.shadowColor = activeColor || 'transparent';
      ctx.shadowBlur = activeColor ? 8 : 0;
      if (pulse > 0) {
        ctx.globalAlpha = 0.25 * (1 - pulse);
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(point.x, point.y, (preset.interchangeRadius + 10 + pulse * 12) * mapScale, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = activeColor ? '#ffffff' : mutedStationFill;
      ctx.strokeStyle = color;
      ctx.lineWidth = (isInterchange ? preset.interchangeStrokeWidth : preset.normalStationStrokeWidth) * mapScale;
      ctx.beginPath();
      ctx.arc(
        point.x,
        point.y,
        (isInterchange ? preset.interchangeRadius : preset.normalStationRadius) * mapScale,
        0,
        Math.PI * 2
      );
      ctx.fill();
      ctx.stroke();
      if (isInterchange && activeColor) {
        ctx.fillStyle = activeColor;
        ctx.beginPath();
        ctx.arc(point.x, point.y, preset.interchangeInnerRadius * mapScale, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    };

    const drawLineLabels = () => {
      if (!settings.showLineNameLabels) return;
      const occupied: Array<{ x: number; y: number; width: number; height: number }> = allStations.map(station => {
        const point = toCanvasPoint(station);
        const radius = ((stationLineCounts[station.id] || 0) > 1 ? preset.interchangeRadius : preset.normalStationRadius) * mapScale + 8;
        return { x: point.x - radius, y: point.y - radius, width: radius * 2, height: radius * 2 };
      });
      allLines.forEach(line => {
        const ordered = line.stationIds.map(id => stationById.get(id)).filter(Boolean) as Station[];
        if (ordered.length < 2) return;
        const label = line.name;
        ctx.font = `${preset.lineLabelFontWeight} ${preset.lineLabelFontSize}px "Microsoft YaHei", "PingFang SC", Arial`;
        const labelWidth = Math.max(52, ctx.measureText(label).width + preset.lineLabelPaddingX * 2);
        const labelHeight = preset.lineLabelFontSize + preset.lineLabelPaddingY * 2 + 2;
        const terminalPairs = [
          { terminal: ordered[0], neighbor: ordered[1], preference: 0 },
          { terminal: ordered[ordered.length - 1], neighbor: ordered[ordered.length - 2], preference: 4 }
        ];
        const best = terminalPairs
          .flatMap(({ terminal, neighbor, preference }) => {
            if (!terminal || !neighbor) return [];
            const terminalPoint = toCanvasPoint(terminal);
            const neighborPoint = toCanvasPoint(neighbor);
            const dx = terminalPoint.x - neighborPoint.x;
            const dy = terminalPoint.y - neighborPoint.y;
            const len = Math.hypot(dx, dy) || 1;
            const outward = { x: dx / len, y: dy / len };
            const normal = { x: -outward.y, y: outward.x };
            const baseDistance = Math.max(28, preset.interchangeRadius * mapScale + 18);
            return [0, labelHeight + 8, -(labelHeight + 8), labelHeight * 2 + 16, -(labelHeight * 2 + 16)].map(
              (sideOffset, index) => {
                const centerX = terminalPoint.x + outward.x * (baseDistance + labelWidth / 2) + normal.x * sideOffset;
                const centerY = terminalPoint.y + outward.y * (baseDistance + labelHeight / 2) + normal.y * sideOffset;
                return {
                  x: centerX - labelWidth / 2,
                  y: centerY - labelHeight / 2,
                  width: labelWidth,
                  height: labelHeight,
                  score: preference + index * 2
                };
              }
            );
          })
          .map(candidate => {
            let score = candidate.score;
            occupied.forEach(other => {
              if (
                candidate.x < other.x + other.width &&
                candidate.x + candidate.width > other.x &&
                candidate.y < other.y + other.height &&
                candidate.y + candidate.height > other.y
              ) {
                score += 90;
              }
            });
            if (candidate.x < 0 || candidate.y < 0 || candidate.x + candidate.width > width || candidate.y + candidate.height > height) {
              score += 35;
            }
            return { ...candidate, score };
          })
          .sort((a, b) => a.score - b.score)[0];
        if (!best) return;
        occupied.push(best);
        ctx.save();
        roundRect(ctx, best.x, best.y, best.width, best.height, best.height / 2);
        ctx.fillStyle = preset.lineLabelFill;
        ctx.strokeStyle = line.color;
        ctx.lineWidth = preset.lineLabelStrokeWidth;
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = preset.lineLabelText;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, best.x + best.width / 2, best.y + best.height / 2);
        ctx.restore();
      });
    };

    const drawBaseMap = (openedCount: number, currentProgress = 0) => {
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = canvasThemeGradient(ctx);
      ctx.fillRect(0, 0, width, height);

      allSections.forEach(section => {
        const start = stationById.get(section.startStationId);
        const end = stationById.get(section.endStationId);
        if (!start || !end) return;
        drawLinePath([toCanvasPoint(start), toCanvasPoint(end)], mutedLineColor, 1, 0.8, preset.lineWidth);
      });

      animationSegments.slice(0, openedCount).forEach(item => {
        drawLinePath(pathToPoints(item.stationIds), item.line.color, 1, 1);
      });

      const current = animationSegments[openedCount];
      if (current) {
        drawLinePath(pathToPoints(current.stationIds), current.line.color, currentProgress, 1, preset.lineWidth + 1);
      }

      const activeStationColors = new Map<string, string>();
      animationSegments.slice(0, openedCount).forEach(item => {
        item.stationIds.forEach(id => activeStationColors.set(id, item.line.color));
      });
      if (current) {
        const currentIds = current.stationIds;
        const activeUntil = Math.max(1, Math.ceil(currentIds.length * currentProgress));
        currentIds.slice(0, activeUntil).forEach(id => activeStationColors.set(id, current.line.color));
      }

      allStations.forEach(station => drawStation(station, activeStationColors.get(station.id)));
      if (current) {
        const endId = current.stationIds[current.stationIds.length - 1];
        const end = stationById.get(endId);
        if (end) drawStation(end, current.line.color, Math.sin(currentProgress * Math.PI));
      }
      drawLineLabels();
    };

    const drawInfoPanel = (item: ReturnType<typeof resolveSegmentPath>, progress: number) => {
      const startStation = stationById.get(item.stationIds[0]);
      const endStation = stationById.get(item.stationIds[item.stationIds.length - 1]);
      const panelWidth = 430;
      const panelHeight = 118;
      const x = 42;
      const y = height - panelHeight - 36;
      ctx.save();
      roundRect(ctx, x, y, panelWidth, panelHeight, 14);
      ctx.fillStyle = isDarkCanvas ? 'rgba(2, 6, 23, 0.86)' : 'rgba(255, 255, 255, 0.9)';
      ctx.strokeStyle = isDarkCanvas ? 'rgba(148, 163, 184, 0.32)' : 'rgba(148, 163, 184, 0.34)';
      ctx.lineWidth = 1;
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = item.line.color;
      roundRect(ctx, x + 18, y + 20, 62, 28, 14);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = '700 13px "Microsoft YaHei", "PingFang SC", Arial';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(item.line.name, x + 49, y + 34);
      ctx.fillStyle = primaryText;
      ctx.font = '800 22px "Microsoft YaHei", "PingFang SC", Arial';
      ctx.textAlign = 'left';
      ctx.fillText(item.segment.openDate, x + 96, y + 32);
      ctx.fillStyle = secondaryText;
      ctx.font = '500 16px "Microsoft YaHei", "PingFang SC", Arial';
      ctx.fillText(`${startStation?.name || '-'}  →  ${endStation?.name || '-'}`, x + 96, y + 64);
      ctx.fillStyle = isDarkCanvas ? '#1e293b' : '#e2e8f0';
      roundRect(ctx, x + 20, y + 88, panelWidth - 40, 8, 4);
      ctx.fill();
      ctx.fillStyle = item.line.color;
      roundRect(ctx, x + 20, y + 88, (panelWidth - 40) * progress, 8, 4);
      ctx.fill();
      ctx.restore();
    };

    const drawTitle = () => {
      drawBaseMap(0, 0);
      ctx.save();
      ctx.fillStyle = isDarkCanvas ? 'rgba(2, 6, 23, 0.72)' : 'rgba(255, 255, 255, 0.72)';
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = primaryText;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '900 44px "Microsoft YaHei", "PingFang SC", Arial';
      ctx.fillText('线路开通演示', width / 2, height / 2 - 18);
      ctx.fillStyle = secondaryText;
      ctx.font = '500 18px "Microsoft YaHei", "PingFang SC", Arial';
      ctx.fillText('按开通日期逐步点亮城市轨道网络', width / 2, height / 2 + 30);
      ctx.restore();
    };

    const drawFrame = (frame: number) => {
      if (frame < titleFrames) {
        drawTitle();
        return;
      }
      const animatedFrame = frame - titleFrames;
      const segmentIndex = Math.min(animationSegments.length - 1, Math.floor(animatedFrame / segmentFrames));
      const segmentFrame = animatedFrame - segmentIndex * segmentFrames;
      if (animatedFrame >= animationSegments.length * segmentFrames) {
        drawBaseMap(animationSegments.length, 1);
        return;
      }
      const progress = Math.min(1, segmentFrame / segmentFrames);
      const easedProgress = 1 - Math.pow(1 - progress, 3);
      const item = animationSegments[segmentIndex];
      drawBaseMap(segmentIndex, easedProgress);
      drawInfoPanel(item, easedProgress);
    };

    const stream = canvas.captureStream(fps);
    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
      ? 'video/webm;codecs=vp9'
      : MediaRecorder.isTypeSupported('video/webm;codecs=vp8')
        ? 'video/webm;codecs=vp8'
        : 'video/webm';
    const recorder = new MediaRecorder(stream, { mimeType });
    const chunks: BlobPart[] = [];
    const videoTrack = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack & { requestFrame?: () => void };
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        chunks.push(event.data);
      }
    };

    const totalFrames = titleFrames + animationSegments.length * segmentFrames + outroFrames;
    let frame = 0;
    const stopPromise: Promise<Blob> = new Promise((resolve) => {
      recorder.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' }));
    });

    recorder.start(100);
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        drawFrame(frame);
        videoTrack?.requestFrame?.();
        frame += 1;
        if (frame >= totalFrames) {
          clearInterval(timer);
          recorder.stop();
          resolve();
        }
      }, 1000 / fps);
    });

    const blob = await stopPromise;
    if (blob.size === 0) {
      throw new Error('视频生成失败：浏览器没有录制到有效画面');
    }
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `metro-demo-${Date.now()}.webm`;
    anchor.click();
    URL.revokeObjectURL(url);
    message.success('视频导出完成，已开始下载');
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

  if (!userProfile) {
    return (
      <div className="auth-layout">
        <AuthPanel onLogin={handleLogin} onRegister={handleRegister} />
      </div>
    );
  }

  return (
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
              />
            </section>

            <section className="metro-user-panel">
              <div className="metro-action-buttons">
                <Button className="metro-action-btn metro-action-btn--primary" size="small" onClick={handleOpenSaveMap}>
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
                <Button className="metro-info-action metro-info-action--primary" size="small" onClick={handleOpenSaveMap}>
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

        <DraggableModal title="我的地图" open={mapsVisible} onCancel={() => setMapsVisible(false)} footer={null}>
          <List
            loading={mapsLoading}
            dataSource={savedMaps}
            locale={{ emptyText: mapsLoading ? '正在加载地图...' : '暂无已保存地图' }}
            renderItem={(item) => (
              <List.Item
                actions={[
                  <Button key="load" type="link" onClick={() => handleLoadMap(item.id)}>
                    加载
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
                  title={item.name}
                  description={`更新时间：${new Date(item.updatedAt).toLocaleString()}`}
                />
              </List.Item>
            )}
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
                onChange={(event) =>
                  setMapSettings((prev) => normalizeMapSettings({ ...prev, canvasTheme: event.target.value }))
                }
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
                onChange={(event) =>
                  setMapSettings((prev) => normalizeMapSettings({ ...prev, mapStyle: event.target.value }))
                }
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
                onChange={(event) =>
                  setMapSettings((prev) => normalizeMapSettings({ ...prev, cityStyle: event.target.value }))
                }
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
                onChange={(event) =>
                  setMapSettings((prev) =>
                    normalizeMapSettings({ ...prev, showLineNameLabels: event.target.value === 'show' })
                  )
                }
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
                  onChange={(value) =>
                    setMapSettings((prev) =>
                      normalizeMapSettings({
                        ...prev,
                        dotLabelStyle: { ...prev.dotLabelStyle, fontSize: value }
                      })
                    )
                  }
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
                  onChange={(value) =>
                    setMapSettings((prev) =>
                      normalizeMapSettings({
                        ...prev,
                        dotLabelStyle: { ...prev.dotLabelStyle, fontWeight: value }
                      })
                    )
                  }
                />
              </div>
              <div className="metro-settings-color-row">
                <span>{text.dotLabelColor}</span>
                <ColorPicker
                  value={mapSettings.dotLabelStyle.color}
                  onChange={(color) =>
                    setMapSettings((prev) =>
                      normalizeMapSettings({
                        ...prev,
                        dotLabelStyle: {
                          ...prev.dotLabelStyle,
                          color: color.toHexString()
                        }
                      })
                    )
                  }
                  showText
                />
              </div>
              <div className="metro-settings-reset-row">
                <Button
                  size="small"
                  onClick={() =>
                    setMapSettings((prev) =>
                      normalizeMapSettings({
                        ...prev,
                        dotLabelStyle: DEFAULT_MAP_SETTINGS.dotLabelStyle
                      })
                    )
                  }
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
              <Input.Password placeholder="不修改可留空" />
            </Form.Item>
            <Form.Item
              label="确认新密码"
              name="confirm"
              dependencies={['password']}
              rules={[
                ({ getFieldValue }) => ({
                  validator(_, value) {
                    if (!value || getFieldValue('password') === value) {
                      return Promise.resolve();
                    }
                    return Promise.reject(new Error('两次输入的密码不一致'));
                  }
                })
              ]}
            >
              <Input.Password placeholder="请再次输入新密码" />
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
  );
};

export default App;
