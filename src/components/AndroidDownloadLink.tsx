import React from 'react';
import { DownloadOutlined } from '@ant-design/icons';
import { isAndroidClient } from '../lib/androidClient';

const AndroidDownloadLink: React.FC = () => isAndroidClient ? null : (
  <a className="auth-mobile-download" href="/android.html">
    <DownloadOutlined /> 下载 Android 客户端 <span>APK</span>
  </a>
);
export default AndroidDownloadLink;
