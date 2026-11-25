// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AppProviders } from '../src/App';
import { ensureSeeded } from '../src/mock/server';

afterEach(() => cleanup());
beforeEach(() => {
  sessionStorage.clear();
  window.location.hash = '';
});

describe('全部页面渲染冒烟', () => {
  it('登录后可访问清单、主管、审计、样例三个标签与授权申请', async () => {
    await ensureSeeded(true);
    render(<AppProviders />);
    fireEvent.click(await screen.findByRole('button', { name: '进入工作台' }));
    await waitFor(() => expect(screen.getAllByText(/陈桂兰/).length).toBeGreaterThan(0), { timeout: 6000 });

    // 主管队列
    fireEvent.click(screen.getByRole('link', { name: /主管确认队列/ }));
    expect(await screen.findByRole('heading', { name: '主管确认队列' })).toBeTruthy();
    // 一键切换主管
    fireEvent.click(screen.getByRole('button', { name: /一键切换为主管/ }));
    await waitFor(() => expect(screen.getByText(/王敏（服务主管）/)).toBeTruthy());

    // 审计页
    fireEvent.click(screen.getByRole('link', { name: /审计日志/ }));
    expect(await screen.findByRole('heading', { name: '审计日志' })).toBeTruthy();
    await waitFor(() => expect(document.querySelectorAll('.timeline li').length).toBeGreaterThan(0));

    // 样例页
    fireEvent.click(screen.getByRole('link', { name: /样例演练/ }));
    expect(await screen.findByRole('heading', { name: '样例演练与双标签重放' })).toBeTruthy();
    // 默认样例一：逐步脚本与字段级结果（步骤 5 内容需要点到第 6 步才出现？字段级结果在 step>=4 渲染）
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));
    expect(await screen.findByText(/两类合并结果之一：字段级三方比较/)).toBeTruthy();

    // 切到样例二
    fireEvent.click(screen.getByRole('tab', { name: /预约取消/ }));
    expect(screen.getByText(/预约先取消、签到后离线上传/)).toBeTruthy();

    // 切到样例三并申请 20 秒授权
    fireEvent.click(screen.getByRole('tab', { name: /撤权与授权到期/ }));
    expect(await screen.findByText(/真实组件：申请 20 秒授权/)).toBeTruthy();
    const grantBtn = screen.getByRole('button', { name: /授予 20 秒/ });
    fireEvent.click(grantBtn);
    await waitFor(() => expect(screen.getByText(/授权有效/)).toBeTruthy(), { timeout: 6000 });
    // 真值出现
    expect(screen.getByText(/139-0000-2046/)).toBeTruthy();
    // RestrictedContact 区域存在撤权按钮
    expect(screen.getByRole('button', { name: /模拟家属撤权/ })).toBeTruthy();

    // 个案页各 tab 也渲染一次
    window.location.hash = '#/case/case-liang';
    await waitFor(() => expect(screen.getByRole('heading', { name: /梁广生/ })).toBeTruthy(), { timeout: 4000 });
    for (const name of ['目标与计划', '预约管理', '转介与提醒', '同步记录']) {
      fireEvent.click(screen.getByRole('tab', { name }));
      // 每个面板至少渲染出卡片或标题；点击不抛错即通过
      await new Promise((r) => setTimeout(r, 30));
    }
    // 回到概览，受限组件应在无授权状态下渲染遮蔽块
    fireEvent.click(screen.getByRole('tab', { name: /概览与授权/ }));
    await waitFor(() => expect(document.querySelector('.secret-box .masked')).toBeTruthy());
  }, 40000);

  it('上门日程编排：两种方案与派工单可渲染，应用需主管身份', async () => {
    await ensureSeeded(true);
    render(<AppProviders />);
    fireEvent.click(await screen.findByRole('button', { name: '进入工作台' }));
    await waitFor(() => expect(screen.getAllByText(/陈桂兰/).length).toBeGreaterThan(0), { timeout: 6000 });

    fireEvent.click(screen.getByRole('link', { name: /上门日程编排/ }));
    expect(await screen.findByRole('heading', { name: /跨个案上门日程编排/ })).toBeTruthy();
    // 两种方案的卡片
    expect(await screen.findByText('方案一 · 保持人员')).toBeTruthy();
    expect(screen.getByText('方案二 · 同意范围内改派')).toBeTruthy();
    // 默认社工身份：应用按钮禁用
    const applyBtn = screen.getByRole('button', { name: /应用「保持人员」方案/ }) as HTMLButtonElement;
    expect(applyBtn.disabled).toBe(true);
    // 逐人时间线与派工单都存在
    expect(document.querySelector('.timeline-grid')).toBeTruthy();
    expect(document.querySelector('.dispatch-sheet')).toBeTruthy();
    // 代号出现，且个案内容不在调度投影表格中泄漏常见隐私字段
    expect(screen.getAllByText(/西区·安（A）/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/清河里 3 号楼 2 单元 102/)).toBeNull();
    // 切到改派方案
    fireEvent.click(screen.getByRole('tab', { name: /在客户同意范围内改派/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: /应用「同意范围内改派」方案/ })).toBeTruthy());
  }, 30000);

  it('样例页提供一键布置与双标签入口', async () => {
    await ensureSeeded(true);
    render(<AppProviders />);
    fireEvent.click(await screen.findByRole('button', { name: '进入工作台' }));
    await waitFor(() => expect(screen.getAllByText(/陈桂兰/).length).toBeGreaterThan(0), { timeout: 6000 });
    const scenarioLinks = screen.getAllByRole('link', { name: /样例演练/ });
    fireEvent.click(scenarioLinks[0]);
    expect(await screen.findByRole('button', { name: /植入 A 草稿并打开字段级冲突中心/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /开标签 A · 林晓/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /开主管标签 · 王敏/ })).toBeTruthy();
  }, 20000);
});
