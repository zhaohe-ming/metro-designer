import React, { useState } from 'react';
import { Button, Form, Input, Typography } from 'antd';
import { LockOutlined, PhoneOutlined, UserOutlined } from '@ant-design/icons';

interface AuthPanelProps {
  onLogin: (payload: { phone: string; password: string }) => void | Promise<void>;
  onRegister: (payload: { phone: string; password: string; username: string }) => void | Promise<void>;
}

type AuthMode = 'login' | 'register';

const { Title, Text } = Typography;

const AuthPanel: React.FC<AuthPanelProps> = ({ onLogin, onRegister }) => {
  const [mode, setMode] = useState<AuthMode>('login');
  const [loading, setLoading] = useState(false);

  const handleLoginFinish = async (values: { phone: string; password: string }) => {
    setLoading(true);
    try {
      await Promise.resolve(onLogin(values));
    } finally {
      setLoading(false);
    }
  };

  const handleRegisterFinish = async (values: {
    phone: string;
    password: string;
    confirm: string;
    username: string;
  }) => {
    setLoading(true);
    try {
      await Promise.resolve(
        onRegister({
          phone: values.phone,
          password: values.password,
          username: values.username
        })
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-card">
      <div className="auth-card__inner">
        <section className="auth-card__info">
          <div className="auth-badge">
            <span className="auth-badge__dot" />
            <span className="auth-badge__text">Metro Designer</span>
          </div>

          <Title className="auth-title">
            设计更像地铁系统
            <br />
            而不是普通流程图
          </Title>

          <Text className="auth-subtitle">
            登录后即可进入城市轨道设计台，创建线路、布置站点、管理区间，并导出适合展示与汇报的地图画面。
          </Text>

          <div className="auth-highlights">
            <div className="auth-highlight">
              <span className="dot" />
              <span>多线路并行设计，颜色与顺序一体管理</span>
            </div>
            <div className="auth-highlight">
              <span className="dot" />
              <span>拖拽站点、连接区间、导出高清图片与演示视频</span>
            </div>
            <div className="auth-highlight">
              <span className="dot" />
              <span>保存地图后可继续覆盖编辑，维持完整设计轨迹</span>
            </div>
          </div>

          <div className="auth-grid" aria-hidden>
            <div className="auth-grid__card">
              <div className="auth-grid__eyebrow">Workbench</div>
              <div className="auth-grid__value">2D</div>
              <div className="auth-grid__copy">围绕线路、区间、站点构建清晰的轨道图层级。</div>
            </div>
            <div className="auth-grid__card">
              <div className="auth-grid__eyebrow">Output</div>
              <div className="auth-grid__value">PNG / WebM</div>
              <div className="auth-grid__copy">适合课程作业、展示汇报与方案演示的导出形态。</div>
            </div>
          </div>
        </section>

        <section className="auth-card__form">
          <div className="auth-form-shell">
            <Title className="auth-form-title">{mode === 'login' ? '欢迎回来' : '创建账号'}</Title>
            <Text className="auth-form-subtitle">
              使用统一的轨道设计工作区，继续之前的地图编辑与导出流程。
            </Text>

            <div className="auth-switcher">
              <button
                type="button"
                className={`auth-switcher__btn ${mode === 'login' ? 'is-active' : ''}`}
                onClick={() => setMode('login')}
              >
                登录
              </button>
              <button
                type="button"
                className={`auth-switcher__btn ${mode === 'register' ? 'is-active' : ''}`}
                onClick={() => setMode('register')}
              >
                注册
              </button>
            </div>

            {mode === 'login' ? (
              <Form className="auth-form" layout="vertical" onFinish={handleLoginFinish} autoComplete="off">
                <Form.Item
                  name="phone"
                  label="手机号"
                  rules={[
                    { required: true, message: '请输入手机号' },
                    { pattern: /^1\d{10}$/, message: '请输入 11 位中国大陆手机号' }
                  ]}
                >
                  <Input
                    prefix={<PhoneOutlined style={{ color: '#8a95aa' }} />}
                    placeholder="请输入手机号"
                    size="large"
                    maxLength={11}
                  />
                </Form.Item>
                <Form.Item
                  name="password"
                  label="密码"
                  rules={[{ required: true, message: '请输入密码' }]}
                >
                  <Input.Password
                    prefix={<LockOutlined style={{ color: '#8a95aa' }} />}
                    placeholder="请输入登录密码"
                    size="large"
                  />
                </Form.Item>
                <Button className="auth-submit-btn" type="primary" htmlType="submit" block size="large" loading={loading}>
                  登录并进入工作台
                </Button>
              </Form>
            ) : (
              <Form className="auth-form" layout="vertical" onFinish={handleRegisterFinish} autoComplete="off">
                <Form.Item
                  name="username"
                  label="用户名"
                  rules={[
                    { required: true, message: '请输入用户名' },
                    { min: 2, message: '至少 2 个字符' }
                  ]}
                >
                  <Input
                    prefix={<UserOutlined style={{ color: '#8a95aa' }} />}
                    placeholder="给自己取一个清晰的名字"
                    size="large"
                    maxLength={12}
                  />
                </Form.Item>
                <Form.Item
                  name="phone"
                  label="手机号"
                  rules={[
                    { required: true, message: '请输入手机号' },
                    { pattern: /^1\d{10}$/, message: '请输入 11 位中国大陆手机号' }
                  ]}
                >
                  <Input
                    prefix={<PhoneOutlined style={{ color: '#8a95aa' }} />}
                    placeholder="用于登录与账户识别"
                    size="large"
                    maxLength={11}
                  />
                </Form.Item>
                <Form.Item
                  name="password"
                  label="密码"
                  rules={[
                    { required: true, message: '请输入密码' },
                    { min: 6, message: '密码长度至少 6 位' }
                  ]}
                >
                  <Input.Password
                    prefix={<LockOutlined style={{ color: '#8a95aa' }} />}
                    placeholder="设置登录密码"
                    size="large"
                  />
                </Form.Item>
                <Form.Item
                  name="confirm"
                  label="确认密码"
                  dependencies={['password']}
                  rules={[
                    { required: true, message: '请再次输入密码' },
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
                  <Input.Password
                    prefix={<LockOutlined style={{ color: '#8a95aa' }} />}
                    placeholder="再次输入密码"
                    size="large"
                  />
                </Form.Item>
                <Button className="auth-submit-btn" type="primary" htmlType="submit" block size="large" loading={loading}>
                  创建账号并进入工作台
                </Button>
              </Form>
            )}

            <div className="auth-form-footer">
              当前为本地演示账户体系，数据会保存到本地服务。后续可继续扩展短信验证、云端同步与团队协作。
            </div>
          </div>
        </section>
      </div>
    </div>
  );
};

export default AuthPanel;
