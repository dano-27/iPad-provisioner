// ╔══════════════════════════════════════════════════════════════════╗
// ║  Vision Agent — Gemini-powered screen reading + interaction      ║
// ║                                                                  ║
// ║  Takes screenshots via Appium, sends to Gemini Vision, parses    ║
// ║  the response into actions (tap, type, swipe), and executes.     ║
// ║  Self-healing: works regardless of app updates or layout.        ║
// ╚══════════════════════════════════════════════════════════════════╝

import { CONFIG } from './config.mjs';

const MAX_ITERATIONS = 20;
const GEMINI_MODEL = 'gemini-3.8-flash';

// ─── Gemini API ───────────────────────────────────────────────

async function callGemini(base64Screenshot, systemPrompt, userPrompt) {
  const apiKey = CONFIG.geminiApiKey;
  if (!apiKey) throw new Error('Gemini API key not set in config.mjs');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{
      parts: [
        {
          inlineData: {
            mimeType: 'image/png',
            data: base64Screenshot,
          },
        },
        { text: userPrompt },
      ],
    }],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json',
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API error (${res.status}): ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Empty response from Gemini');

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Failed to parse Gemini response as JSON: ${text.slice(0, 200)}`);
  }
}

// ─── System Prompt ────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an AI agent controlling an iPad over USB. You can see screenshots of the iPad screen and must decide what action to take next.

You will be given:
1. A screenshot of the current iPad screen
2. A task description (what you're trying to accomplish)
3. A history of actions you've already taken

You must respond with a single JSON object describing the next action. Available actions:

{
  "action": "tap",
  "x": <number>,           // X coordinate to tap (in screen pixels)
  "y": <number>,           // Y coordinate to tap (in screen pixels)
  "description": "<string>" // What you're tapping and why
}

{
  "action": "type",
  "text": "<string>",       // Text to type (assumes a field is already focused)
  "description": "<string>"
}

{
  "action": "tap_and_type",
  "x": <number>,           // X coordinate of the input field to tap first
  "y": <number>,           // Y coordinate of the input field to tap first
  "text": "<string>",       // Text to type after tapping
  "description": "<string>"
}

{
  "action": "press_button",
  "button": "enter",        // Press the Enter/Return key
  "description": "<string>"
}

{
  "action": "wait",
  "seconds": <number>,     // How long to wait (1-10)
  "description": "<string>" // Why you're waiting (loading, animation, etc.)
}

{
  "action": "swipe",
  "startX": <number>, "startY": <number>,
  "endX": <number>, "endY": <number>,
  "description": "<string>"
}

{
  "action": "done",
  "success": true,
  "description": "<string>" // What was accomplished
}

{
  "action": "error",
  "description": "<string>" // Why you can't proceed
}

Rules:
- Look at the screenshot carefully. Identify buttons, text fields, labels, and navigation elements.
- Provide coordinates that are in the CENTER of the element you want to interact with.
- If you see a loading screen or spinner, use "wait".
- If you see a dialog/popup/alert, dismiss it appropriately before continuing the main task.
- If you see the task is already complete (e.g., you're on the main dashboard after signing in), return "done".
- If you're stuck after several attempts, return "error" with an explanation.
- Be precise with coordinates. Look at the actual positions of UI elements in the screenshot.`;

// ─── Action Execution ─────────────────────────────────────────

async function executeAction(browser, action) {
  switch (action.action) {
    case 'tap':
      await browser.action('pointer', { parameters: { pointerType: 'touch' } })
        .move({ x: Math.round(action.x), y: Math.round(action.y) })
        .down()
        .pause(100)
        .up()
        .perform();
      await browser.pause(800);
      break;

    case 'type':
      await browser.keys(action.text);
      await browser.pause(500);
      break;

    case 'tap_and_type':
      await browser.action('pointer', { parameters: { pointerType: 'touch' } })
        .move({ x: Math.round(action.x), y: Math.round(action.y) })
        .down()
        .pause(100)
        .up()
        .perform();
      await browser.pause(800);
      await browser.keys(action.text);
      await browser.pause(500);
      break;

    case 'press_button':
      if (action.button === 'enter') {
        await browser.keys('\n');
      }
      await browser.pause(800);
      break;

    case 'wait':
      await browser.pause((action.seconds || 2) * 1000);
      break;

    case 'swipe':
      await browser.action('pointer', { parameters: { pointerType: 'touch' } })
        .move({ x: Math.round(action.startX), y: Math.round(action.startY) })
        .down()
        .pause(100)
        .move({ x: Math.round(action.endX), y: Math.round(action.endY), duration: 300 })
        .up()
        .perform();
      await browser.pause(600);
      break;

    case 'done':
    case 'error':
      // Terminal states — no action needed
      break;

    default:
      throw new Error(`Unknown action type: ${action.action}`);
  }
}

// ─── Vision Agent Loop ────────────────────────────────────────

/**
 * Runs the vision agent loop.
 *
 * @param {object} browser - WebDriverIO browser session (connected to iPad via Appium)
 * @param {string} task - Natural language description of the task
 * @param {function} onStep - Callback(iteration, action) for progress updates
 * @returns {{ success: boolean, iterations: number, history: object[] }}
 */
export async function runVisionAgent(browser, task, onStep) {
  const history = [];

  // Determine coordinate scale factor (screenshot pixels vs Appium points)
  // Appium works in POINTS, but screenshots are in PIXELS (2x on Retina iPads)
  let scaleFactor = 2; // default for Retina iPads
  try {
    const windowSize = await browser.getWindowRect();  // returns points
    const screenshot0 = await browser.takeScreenshot();
    // Decode PNG header to get pixel dimensions
    const buf = Buffer.from(screenshot0, 'base64');
    // PNG width is at bytes 16-19, height at 20-23 (big-endian)
    if (buf[0] === 0x89 && buf[1] === 0x50) { // valid PNG
      const imgWidth = buf.readUInt32BE(16);
      scaleFactor = imgWidth / windowSize.width;
      console.log(`[VisionAgent] Window: ${windowSize.width}x${windowSize.height} pts, Screenshot: ${imgWidth} px wide, Scale: ${scaleFactor}`);
    }
  } catch (e) {
    console.log(`[VisionAgent] Could not determine scale factor, using default ${scaleFactor}: ${e.message}`);
  }

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    // 1. Take screenshot
    const screenshot = await browser.takeScreenshot(); // base64 PNG

    // 2. Build the user prompt with history context
    const historyText = history.length
      ? `\n\nActions taken so far:\n${history.map((h, idx) => `  ${idx + 1}. [${h.action}] ${h.description}`).join('\n')}`
      : '\n\nNo actions taken yet — this is the first screenshot.';

    const userPrompt = `TASK: ${task}${historyText}\n\nLook at the current screenshot and decide the next action. Respond with a single JSON object.`;

    // 3. Ask Gemini
    let action;
    try {
      action = await callGemini(screenshot, SYSTEM_PROMPT, userPrompt);
    } catch (err) {
      if (onStep) onStep(i, { action: 'error', description: `Gemini call failed: ${err.message}` });
      return { success: false, iterations: i + 1, history, error: err.message };
    }

    // 4. Scale pixel coordinates to points before execution
    if (scaleFactor !== 1) {
      const rawX = action.x, rawY = action.y;
      if (action.x !== undefined) action.x = action.x / scaleFactor;
      if (action.y !== undefined) action.y = action.y / scaleFactor;
      if (action.startX !== undefined) action.startX = action.startX / scaleFactor;
      if (action.startY !== undefined) action.startY = action.startY / scaleFactor;
      if (action.endX !== undefined) action.endX = action.endX / scaleFactor;
      if (action.endY !== undefined) action.endY = action.endY / scaleFactor;
      if (rawX !== undefined) console.log(`[VisionAgent] Step ${i+1}: ${action.action} "${action.description}" — raw(${rawX},${rawY}) → scaled(${Math.round(action.x)},${Math.round(action.y)})`);
    }

    // 5. Report progress
    if (onStep) onStep(i, action);
    history.push(action);

    // 6. Check for terminal states
    if (action.action === 'done') {
      return { success: action.success !== false, iterations: i + 1, history };
    }
    if (action.action === 'error') {
      return { success: false, iterations: i + 1, history, error: action.description };
    }

    // 7. Execute the action
    try {
      await executeAction(browser, action);
    } catch (err) {
      if (onStep) onStep(i, { action: 'error', description: `Action failed: ${err.message}` });
      return { success: false, iterations: i + 1, history, error: err.message };
    }
  }

  return { success: false, iterations: MAX_ITERATIONS, history, error: 'Max iterations reached' };
}
