import type { ITheme } from "@xterm/xterm";

export function terminalTheme(): ITheme {
  const styles = getComputedStyle(document.documentElement);
  const color = (name: string) => styles.getPropertyValue(`--${name}`).trim();
  return {
    background: color("terminal-background"),
    foreground: color("terminal-foreground"),
    cursor: color("primary"),
    cursorAccent: color("terminal-background"),
    selectionBackground: color("terminal-selection"),
    selectionInactiveBackground: color("terminal-selection-inactive"),
    black: color("terminal-black"),
    red: color("terminal-red"),
    green: color("terminal-green"),
    yellow: color("terminal-yellow"),
    blue: color("terminal-blue"),
    magenta: color("terminal-magenta"),
    cyan: color("terminal-cyan"),
    white: color("terminal-white"),
    brightBlack: color("terminal-bright-black"),
    brightRed: color("terminal-bright-red"),
    brightGreen: color("terminal-bright-green"),
    brightYellow: color("terminal-bright-yellow"),
    brightBlue: color("terminal-bright-blue"),
    brightMagenta: color("terminal-bright-magenta"),
    brightCyan: color("terminal-bright-cyan"),
    brightWhite: color("terminal-bright-white"),
  };
}
