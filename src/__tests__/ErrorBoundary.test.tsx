/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { GlobalErrorBoundary } from '../ui/GlobalErrorBoundary';

const ThrowingComponent = () => {
  throw new Error('Test component crashed');
};

describe('GlobalErrorBoundary', () => {
  it('catches render error and displays CrashScreen', () => {
    // Suppress console.error in test
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <GlobalErrorBoundary surface="editor" isDev={false}>
        <ThrowingComponent />
      </GlobalErrorBoundary>
    );

    expect(screen.getByText(/AeonStagery 遇到了意外错误/i)).toBeInTheDocument();
    expect(screen.getByText(/请勿直接只?发送本窗口截图/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /重启应用/i })).toBeInTheDocument();

    consoleSpy.mockRestore();
  });
});
