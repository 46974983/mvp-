import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Composer } from '@/components/chat/Composer';
import { MessageList } from '@/components/chat/MessageList';
import { Sidebar } from '@/components/layout/Sidebar';
import { ScreenshotSettings } from '@/components/settings/ScreenshotSettings';
import { useChatStore, useConversationsStore, useSettingsStore } from '@/features';

describe('发送准备阶段的交互', () => {
  it('待处理模型访问请求时锁定会话切换和新建入口', () => {
    const originalChat = useChatStore.getState();
    const originalConversations = useConversationsStore.getState();
    const conversation = {
      id: 'conversation-tool',
      title: '工具请求中的会话',
      createdAt: 1,
      updatedAt: 1,
      archived: false,
    };

    // 顺序有讲究：chat store 订阅了会话的 activeId，会话一换就把待处理的
    // 工具请求复位掉（那是兜底，正常路径是界面上不让切）。
    // 所以先摆好会话，再挂上待处理请求。
    useConversationsStore.setState({
      conversations: [conversation],
      activeId: conversation.id,
      messages: [],
      loaded: true,
    });
    useChatStore.setState({
      sending: false,
      streaming: false,
      toolRequest: {
        messageId: 'assistant-1',
        text: '我先看一下。',
        calls: [{ id: 'call-1', name: 'read_file', arguments: '{"path":"notes.md"}' }],
      },
    });

    const onRequestDelete = vi.fn();
    try {
      render(<Sidebar onRequestDelete={onRequestDelete} />);
      render(<Composer />);

      expect(screen.getByTestId('new-conversation')).toBeDisabled();
      expect(screen.getByTestId('rename-conversation')).toBeDisabled();
      expect(screen.getByTestId('delete-conversation')).toBeDisabled();
      expect(screen.getByTestId('composer-input')).toBeDisabled();
    } finally {
      useChatStore.setState({
        sending: originalChat.sending,
        streaming: originalChat.streaming,
        streamingMessageId: originalChat.streamingMessageId,
        streamingText: originalChat.streamingText,
        error: originalChat.error,
        lastOutcome: originalChat.lastOutcome,
        pendingAttachments: originalChat.pendingAttachments,
        toolRequest: originalChat.toolRequest,
      });
      useConversationsStore.setState({
        conversations: originalConversations.conversations,
        activeId: originalConversations.activeId,
        messages: originalConversations.messages,
        loaded: originalConversations.loaded,
        switchingConversation: originalConversations.switchingConversation,
      });
    }
  });

  it('显示停止按钮，并锁定会话侧栏操作', () => {
    const originalChat = useChatStore.getState();
    const originalConversations = useConversationsStore.getState();
    const conversation = {
      id: 'conversation-1',
      title: '已有会话',
      createdAt: 1,
      updatedAt: 1,
      archived: false,
    };

    useChatStore.setState({ sending: true, streaming: false });
    useConversationsStore.setState({
      conversations: [conversation],
      activeId: null,
      messages: [],
      loaded: true,
    });

    const onRequestDelete = vi.fn();
    try {
      const composer = render(<Composer />);
      const sidebar = render(<Sidebar onRequestDelete={onRequestDelete} />);
      const messages = render(<MessageList />);

      expect(screen.getByTestId('stop-button')).toBeVisible();
      expect(screen.queryByTestId('send-button')).not.toBeInTheDocument();
      expect(screen.getByTestId('new-conversation')).toBeDisabled();
      expect(screen.getByRole('button', { name: '新建一个会话' })).toBeDisabled();
      expect(screen.getByTestId('rename-conversation')).toBeDisabled();
      expect(screen.getByTestId('delete-conversation')).toBeDisabled();

      fireEvent.click(screen.getByTestId('conversation-item'));
      expect(useConversationsStore.getState().activeId).toBeNull();
      expect(onRequestDelete).not.toHaveBeenCalled();

      sidebar.unmount();
      composer.unmount();
      messages.unmount();
    } finally {
      useChatStore.setState({
        sending: originalChat.sending,
        streaming: originalChat.streaming,
        streamingMessageId: originalChat.streamingMessageId,
        streamingText: originalChat.streamingText,
        error: originalChat.error,
        lastOutcome: originalChat.lastOutcome,
      });
      useConversationsStore.setState({
        conversations: originalConversations.conversations,
        activeId: originalConversations.activeId,
        messages: originalConversations.messages,
        loaded: originalConversations.loaded,
        switchingConversation: originalConversations.switchingConversation,
      });
    }
  });

  it('会话切换尚未完成时忽略侧栏行点击', () => {
    const original = useConversationsStore.getState();
    const conversation = {
      id: 'conversation-2',
      title: '另一个会话',
      createdAt: 2,
      updatedAt: 2,
      archived: false,
    };
    const select = vi.fn(async () => undefined);

    useConversationsStore.setState({
      conversations: [conversation],
      activeId: 'conversation-1',
      messages: [],
      loaded: true,
      switchingConversation: true,
      select,
    });

    const sidebar = render(<Sidebar onRequestDelete={vi.fn()} />);
    try {
      fireEvent.click(screen.getByTestId('conversation-item'));
      expect(select).not.toHaveBeenCalled();
    } finally {
      sidebar.unmount();
      useConversationsStore.setState({
        conversations: original.conversations,
        activeId: original.activeId,
        messages: original.messages,
        loaded: original.loaded,
        switchingConversation: original.switchingConversation,
        select: original.select,
      });
    }
  });

  it('浏览器模式明确说明截屏开关只在桌面模式提供', () => {
    const originalSettings = useSettingsStore.getState();
    useSettingsStore.setState({
      loaded: true,
      platformId: 'browser',
      platformCapabilities: [],
    });

    try {
      render(<ScreenshotSettings />);
      expect(screen.getByTestId('screenshot-unavailable')).toHaveTextContent(
        '浏览器模式不提供截屏能力；桌面模式才有这个开关。'
      );
      expect(screen.queryByTestId('screenshot-switch')).not.toBeInTheDocument();
    } finally {
      useSettingsStore.setState({
        loaded: originalSettings.loaded,
        platformId: originalSettings.platformId,
        platformCapabilities: originalSettings.platformCapabilities,
      });
    }
  });
});
