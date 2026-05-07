type AmapWindow = Window & {
  AMap?: any;
  _AMapSecurityConfig?: {
    securityJsCode?: string;
  };
};

let amapPromise: Promise<any> | null = null;

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

  if (amapWindow.AMap) {
    return Promise.resolve(amapWindow.AMap);
  }

  if (!amapPromise) {
    amapPromise = new Promise((resolve, reject) => {
      const existing = document.querySelector<HTMLScriptElement>('script[data-amap-jsapi="true"]');
      if (existing) {
        existing.addEventListener('load', () => resolve((window as AmapWindow).AMap));
        existing.addEventListener('error', () => reject(new Error('高德地图脚本加载失败')));
        return;
      }

      const script = document.createElement('script');
      script.dataset.amapJsapi = 'true';
      script.async = true;
      script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(key)}`;
      script.onload = () => resolve((window as AmapWindow).AMap);
      script.onerror = () => reject(new Error('高德地图脚本加载失败'));
      document.head.appendChild(script);
    });
  }

  return amapPromise;
};
