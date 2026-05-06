import React, { useEffect, useRef, useState } from 'react';
import { Avatar, Button, Divider, Form, Input, Layout, List, Popconfirm, Space, message } from 'antd';
import { api, clearToken, getToken, setToken } from './api';
import AuthPanel from './components/AuthPanel';
import Canvas from './components/Canvas';
import DraggableModal from './components/DraggableModal';
import Sidebar from './components/Sidebar';
import Toolbar from './components/Toolbar';
import VideoExportModal, { VideoSegmentInput } from './components/VideoExportModal';
import { Line, Section, Station } from './types';

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
  const stageRef = useRef<any>(null);
  const avatarInputRef = useRef<HTMLInputElement | null>(null);

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
        const { map } = await api.updateMap(currentMap.id, { name, lines, stations, sections });
        setCurrentMap(map);
        upsertSavedMap(map);
        setSaveMapVisible(false);
        setMapName('');
        message.success('地图已覆盖保存');
        return;
      }

      const { map } = await api.createMap({ name, lines, stations, sections });
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
      await exportVideoFromStage(stageRef.current, segments, lines, stations);
    } catch (error) {
      console.error(error);
      message.error('导出失败，请重试');
    } finally {
      setIsExporting(false);
    }
  };

  const exportVideoFromStage = async (
    stage: any,
    segments: VideoSegmentInput[],
    allLines: Line[],
    allStations: Station[]
  ) => {
    if (!segments.length) {
      message.warning('请至少填写一个开通区间');
      return;
    }

    const width = stage.width();
    const height = stage.height();
    const snapshotUrl = stage.toDataURL({ pixelRatio: 2 });

    const baseImage: HTMLImageElement = await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = snapshotUrl;
    });

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      message.error('浏览器不支持导出视频');
      return;
    }

    const stream = canvas.captureStream(30);
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
    const chunks: BlobPart[] = [];

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        chunks.push(event.data);
      }
    };

    const fps = 30;
    const secondsPerSegment = 3;
    const totalFrames = segments.length * fps * secondsPerSegment;
    let frame = 0;

    const drawFrame = () => {
      const segmentIndex = Math.floor(frame / (fps * secondsPerSegment));
      const segmentProgress = (frame % (fps * secondsPerSegment)) / (fps * secondsPerSegment);
      const segment = segments[segmentIndex] || segments[segments.length - 1];
      const line = allLines.find((item) => item.id === segment.lineId);
      const startStation = allStations.find((item) => item.id === segment.startStationId);
      const endStation = allStations.find((item) => item.id === segment.endStationId);
      const overlayColor = line?.color || '#1890ff';

      ctx.clearRect(0, 0, width, height);
      const zoom = 1 + 0.05 * Math.sin(segmentProgress * Math.PI);
      const drawWidth = width * zoom;
      const drawHeight = height * zoom;
      ctx.drawImage(baseImage, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);

      const panelWidth = Math.min(360, width * 0.45);
      const panelHeight = 90;
      ctx.globalAlpha = 0.78;
      ctx.fillStyle = '#0b1b2a';
      ctx.fillRect(12, height - panelHeight - 12, panelWidth, panelHeight);
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#fff';
      ctx.font = '16px "Microsoft YaHei", "PingFang SC", Arial';
      ctx.fillText(`开通日期：${segment.openDate}`, 24, height - panelHeight + 20);
      ctx.fillText(`线路：${line?.name || '未选择'}`, 24, height - panelHeight + 44);
      ctx.fillText(`区间：${startStation?.name || '-'} -> ${endStation?.name || '-'}`, 24, height - panelHeight + 68);
      ctx.fillStyle = overlayColor;
      ctx.fillRect(panelWidth - 28, height - panelHeight - 12, 16, panelHeight);
    };

    const stopPromise: Promise<Blob> = new Promise((resolve) => {
      recorder.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' }));
    });

    recorder.start();
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        drawFrame();
        frame += 1;
        if (frame >= totalFrames) {
          clearInterval(timer);
          recorder.stop();
          resolve();
        }
      }, 1000 / fps);
    });

    const blob = await stopPromise;
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

  const displayName = userProfile?.username || '地铁设计师';
  const displayInitial = (userProfile?.username || userProfile?.phone || 'M').charAt(0).toUpperCase();
  const activeLine = lines.find((line) => line.id === currentLineId) || null;
  const mapDisplayName = currentMap?.name || '未命名方案';
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
    <div className="metro-app-shell">
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
                  {currentMap ? '覆盖保存' : '保存地图'}
                </Button>
                <Button className="metro-action-btn" size="small" loading={mapsLoading} onClick={handleOpenMapList}>
                  查看地图
                </Button>
                <Button className="metro-action-btn metro-action-btn--warn" size="small" onClick={() => setProfileVisible(true)}>
                  个人中心
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
                <Button className="metro-user-link" type="text" size="small" onClick={() => setProfileVisible(true)}>
                  个人中心
                </Button>
                <Button className="metro-logout-btn" size="small" onClick={handleLogout}>
                  退出
                </Button>
              </div>
            </section>
          </div>
        </Header>

        <Layout className="metro-body">
          <Sider className="metro-sider" width={252}>
            <Sidebar
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

        <DraggableModal title="个人中心" open={profileVisible} onCancel={() => setProfileVisible(false)} footer={null}>
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
              <div style={{ color: '#8c8c8c' }}>手机号：+86 {userProfile.phone}</div>
              <div style={{ color: '#8c8c8c', fontSize: 12 }}>点击头像可上传本机图片</div>
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
        </DraggableModal>

        <DraggableModal open={isExporting} footer={null} closable={false} centered>
          正在导出动态视频，请稍候…
        </DraggableModal>
      </Layout>
    </div>
  );
};

export default App;
