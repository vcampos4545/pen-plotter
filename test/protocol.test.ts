import { describe, expect, it } from 'vitest';
import { classifyResponse, isControlMessage, LineAssembler, parseStatus, workPosition } from '../src/protocol';
import { sanitizeSettings, websocketUrl, DEFAULT_SETTINGS } from '../src/settings';

describe('LineAssembler', () => {
  it('splits coalesced frames and joins partial lines', () => {
    const a = new LineAssembler();
    expect(a.push('ok\r\nok\r\n<Idle|MPos:0')).toEqual(['ok', 'ok']);
    expect(a.push('.000,0.000,0.000|FS:0,0>\r')).toEqual([]);
    expect(a.push('\nerror:20\n')).toEqual(['<Idle|MPos:0.000,0.000,0.000|FS:0,0>', 'error:20']);
  });
});

describe('parseStatus', () => {
  it('parses state, substate, positions and feed', () => {
    expect(parseStatus('<Hold:0|MPos:1.000,2.500,5.000|FS:1500,0|WCO:1.000,0.500,0.000>')).toEqual({
      state: 'Hold',
      subState: '0',
      mpos: [1, 2.5, 5],
      feed: 1500,
      wco: [1, 0.5, 0],
    });
    expect(parseStatus('ok')).toBeUndefined();
  });

  it('derives work position', () => {
    const r = parseStatus('<Run|MPos:10.000,20.000,0.000|FS:0,0>')!;
    expect(workPosition(r, [1, 2, 0])).toEqual([9, 18, 0]);
    expect(workPosition(parseStatus('<Idle|WPos:3.000,4.000,5.000>')!)).toEqual([3, 4, 5]);
  });
});

describe('classifyResponse', () => {
  it('recognizes the message kinds', () => {
    expect(classifyResponse('ok').type).toBe('ok');
    expect(classifyResponse('error:20')).toMatchObject({ type: 'error', code: '20' });
    expect(classifyResponse('ALARM:3')).toMatchObject({ type: 'alarm', code: '3' });
    expect(classifyResponse('<Idle|MPos:0,0,0>').type).toBe('status');
    expect(classifyResponse("Grbl 3.9 [FluidNC v4.1.1 (wifi) '$' for help]").type).toBe('greeting');
    expect(classifyResponse('[MSG:INFO: Caution: Unlocked]').type).toBe('message');
  });

  it('filters WebUI control frames', () => {
    expect(isControlMessage('currentID:3')).toBe(true);
    expect(isControlMessage('CURRENT_ID:3')).toBe(true);
    expect(isControlMessage('PING:60000:60000')).toBe(true);
    expect(isControlMessage('ok')).toBe(false);
  });
});

describe('settings', () => {
  it('builds the WebSocket URL', () => {
    expect(websocketUrl(DEFAULT_SETTINGS)).toBe('ws://plotter.local:80/');
    expect(websocketUrl({ host: '192.168.1.50', port: 81, path: 'ws' })).toBe('ws://192.168.1.50:81/ws');
    expect(websocketUrl({ host: 'fe80::1', port: 80, path: '/' })).toBe('ws://[fe80::1]:80/');
  });

  it('sanitizes bad values back to defaults', () => {
    const s = sanitizeSettings({ port: 'abc', drawFeed: -5, margin: 300, host: '  myplotter.local ', penDwell: '0.3', path: 'x' });
    expect(s.port).toBe(80);
    expect(s.drawFeed).toBe(DEFAULT_SETTINGS.drawFeed);
    expect(s.margin).toBe(10);
    expect(s.host).toBe('myplotter.local');
    expect(s.penDwell).toBe(0.3);
    expect(s.path).toBe('/x');
  });
});
