import React, { useState } from 'react';
import { Button, Form, Input, Typography } from 'antd';
import { ArrowRightOutlined, LockOutlined, PhoneOutlined, UserOutlined } from '@ant-design/icons';
import authHeroImage from '../assets/auth-metro-hero.png';

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
    <div className={`auth-card auth-card--${mode}`}>
      <div className="auth-card__inner">
        <section className="auth-card__info" aria-hidden="true">
          <img className="auth-hero-image" src={authHeroImage} alt="" />
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
              <Form
                className="auth-form"
                layout="vertical"
                onFinish={handleLoginFinish}
                autoComplete="off"
                requiredMark={false}
              >
                <Form.Item
                  name="phone"
                  label="手机号"
                  rules={[
                    { required: true, message: '请输入手机号' },
                    { pattern: /^1\d{10}$/, message: '请输入 11 位中国大陆手机号' }
                  ]}
                >
                  <Input
                    prefix={<PhoneOutlined />}
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
                    prefix={<LockOutlined />}
                    placeholder="请输入登录密码"
                    size="large"
                  />
                </Form.Item>
                <Button className="auth-submit-btn" type="primary" htmlType="submit" block size="large" loading={loading}>
                  登录并进入工作台
                  <ArrowRightOutlined />
                </Button>
              </Form>
            ) : (
              <Form
                className="auth-form"
                layout="vertical"
                onFinish={handleRegisterFinish}
                autoComplete="off"
                requiredMark={false}
              >
                <Form.Item
                  name="username"
                  label="用户名"
                  rules={[
                    { required: true, message: '请输入用户名' },
                    { min: 2, message: '至少 2 个字符' }
                  ]}
                >
                  <Input
                    prefix={<UserOutlined />}
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
                    prefix={<PhoneOutlined />}
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
                    prefix={<LockOutlined />}
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
                    prefix={<LockOutlined />}
                    placeholder="再次输入密码"
                    size="large"
                  />
                </Form.Item>
                <Button className="auth-submit-btn" type="primary" htmlType="submit" block size="large" loading={loading}>
                  创建账号并进入工作台
                  <ArrowRightOutlined />
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
