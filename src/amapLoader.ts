type AmapWindow = Window & {
  AMap?: any;
  _AMapSecurityConfig?: {
    securityJsCode?: string;
  };
};

let amapPromise: Promise<any> | null = null;

const getLoadedAmap = () => {
  const AMap = (window as AmapWindow).AMap;
  return AMap?.Map ? AMap : null;
};

export const getAmapConfig = () => ({
  key: process.env.REACT_APP_AMAP_KEY || '',
  securityCode: process.env.REACT_APP_AMAP_SECURITY_CODE || ''
});

export const loadAmap = () => {
  const { key, securityCode } = getAmapConfig();
  if (!key || !securityCode) {
    return Promise.reject(new Error('高德地图 Key 或安全密钥未配置'));
  }

  const amapWindow = window as AmapWindow;
  amapWindow._AMapSecurityConfig = {
    ...(amapWindow._AMapSecurityConfig || {}),
    securityJsCode: securityCode
  };

  const loadedAmap = getLoadedAmap();
  if (loadedAmap) {
    return Promise.resolve(loadedAmap);
  }

  if (!amapPromise) {
    amapPromise = new Promise((resolve, reject) => {
      const existing = document.querySelector<HTMLScriptElement>('script[data-amap-jsapi="true"]');
      if (existing) {
        const existingAmap = getLoadedAmap();
        if (existingAmap) {
          resolve(existingAmap);
          return;
        }
        existing.addEventListener('load', () => {
          const AMap = getLoadedAmap();
          if (AMap) {
            resolve(AMap);
            return;
          }
          reject(new Error('高德地图 SDK 未完成初始化，请检查 Key、安全密钥和域名白名单'));
        });
        existing.addEventListener('error', () => reject(new Error('高德地图脚本加载失败')));
        return;
      }

      const script = document.createElement('script');
      script.dataset.amapJsapi = 'true';
      script.async = true;
      script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(key)}`;
      script.onload = () => {
        const AMap = getLoadedAmap();
        if (AMap) {
          resolve(AMap);
          return;
        }
        reject(new Error('高德地图 SDK 未完成初始化，请检查 Key、安全密钥和域名白名单'));
      };
      script.onerror = () => reject(new Error('高德地图脚本加载失败'));
      document.head.appendChild(script);
    });
  }

  return amapPromise;
};
