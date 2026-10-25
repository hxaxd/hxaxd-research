<div align="center">

# hxaxd-research

<p><a href="README.md">中文</a> &nbsp;·&nbsp; <b>English</b></p>

<h3>Move your research forward with your voice, from your mobile device.</h3>

<p>Your computer · Your network · Your compute</p>

<p>
  <a href="#quick-start"><b>Get started</b></a> &nbsp;·&nbsp;
  <a href="#why-use-it">Why use it?</a> &nbsp;·&nbsp;
  <a href="#start-with-a-research-question">Examples</a> &nbsp;·&nbsp;
  <a href="https://github.com/hxaxd/hxaxd-research/issues">Feedback</a>
</p>

<sub>Browser access &nbsp; / &nbsp; ChatGPT subscription &nbsp; / &nbsp; Mobile access through <a href="https://github.com/hxaxd/remote-everything">Remote Everything</a> &nbsp; / &nbsp; Designed for landscape tablets</sub>

</div>

Find papers, translate them, understand them, design experiments around your ideas, write code, run and analyze results, then write, submit, and publish your paper. hxaxd-research aims to let you work through this entire research cycle with AI: pick up your mobile device and speak your request, wherever you can connect to your research environment.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/workbench-dark.png">
  <source media="(prefers-color-scheme: light)" srcset=".github/assets/workbench-light.png">
  <img src=".github/assets/workbench-light.png" alt="Research workbench: materials on the left, a document with equations and tables in the center, and AI discussion with quoted passages on the right">
</picture>

<p align="center"><sub>Nothing fancy. Just a familiar, comfortable interface.</sub></p>

Read, ask questions, and make decisions on your mobile device. AI handles files and runs code on your own computer, using your network and compute, and brings the results back to you.

## Why use it?

<table>
  <tr>
    <td width="50%" valign="top">
      <h3>Take your research environment with you</h3>
      <p>Run the workbench on your own computer and use it through a browser. Connect from mobile devices with <a href="https://github.com/hxaxd/remote-everything">Remote Everything</a>, keeping your files, dependencies, and computation in the same environment.</p>
      <p><sub>Browser access · Mobile access · Private computing environment</sub></p>
    </td>
    <td width="50%" valign="top">
      <h3>Keep reading. Speak your next step.</h3>
      <p>Use voice input directly on the page. The assistant knows your current file and PDF page. Select a passage or a region of an image to ask about it, and open generated results directly, with less app switching and context copying.</p>
      <p><sub>Voice input · Passage references · One workspace</sub></p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>Settle into reading on your tablet</h3>
      <p>The layout and touch controls are designed for landscape tablets. Core actions work without a mouse or physical keyboard. Collapse sidebars, resize panes, and move between reading and discussion comfortably during long sessions.</p>
      <p><sub>Touch controls · Continuous reading · Light and dark themes</sub></p>
    </td>
    <td width="50%" valign="top">
      <h3>Use the ChatGPT subscription you already have</h3>
      <p>Connect ChatGPT and use eligible subscription allowances for your research. Other model providers and compatible APIs are supported, with separate configuration for speech services.</p>
      <p><sub>Subscription access · Model choice · Configurable speech</sub></p>
    </td>
  </tr>
</table>

### Two core choices behind paper translation

1. **Start with the source, then translate and rebuild.** Find the paper's TeX project or official HTML and translate it into Chinese. Preserve the TeX project structure and recompile it, or translate the HTML and render it again. OCR is used only when those sources are unavailable and all you have is a PDF. Working from the source preserves text, equations, citations, and section relationships while reducing recognition and layout reconstruction errors.
2. **Give the original text to a capable model for accurate, readable, academically polished Chinese.** Use the full paper's context to understand concepts and arguments, keep terminology consistent, and preserve the original logic and detail while producing natural, clear Chinese that helps you understand the paper.

## Quick start

Install **Node.js 24+** and Git on the computer that will run the workbench.

```sh
git clone https://github.com/hxaxd/hxaxd-research.git
cd hxaxd-research
```

| Windows (PowerShell) | macOS / Linux (Shell) |
| --- | --- |
| `powershell -ExecutionPolicy Bypass -File .\install.ps1` | `sh ./install.sh` |

The script installs dependencies, prepares runtime configuration and templates, and builds the application. Start it with:

```sh
npm start -- --hostname 127.0.0.1 --port 8642
```

The default listening address is `127.0.0.1`, on port `8642`. Open **<http://127.0.0.1:8642>**.

## Start with a research question

1. Create a workspace, then import a PDF, documents, or an entire materials directory.
2. Open a document, select a passage or an image region, and ask a question. You can also tap the microphone and speak.
3. Ask the assistant to turn the discussion into notes, a translation, or a draft, or take it further with experiment scripts. Review results, make changes, and keep working in the same workspace.

<details open>
<summary><b>Find papers → Translate → Understand together</b></summary>

> Find papers on small object detection, download them into the workspace, and open the one most worth reading first.

> Translate this paper directly, then let's read it section by section, starting with the method.

</details>

<details>
<summary><b>An idea → Experiment design → Implementation and validation</b></summary>

> I'd like to replace the module we just discussed with this approach. Help me design a minimal experiment to test it. Once we agree on the plan, write and run the code.

</details>

<details>
<summary><b>Literature and experiment records → A paper draft</b></summary>

> Use our literature, code, and experiment records to draft the method and experiments sections. Flag claims that need more evidence, and let's revise the paper together.

</details>

## Data and scope

<details>
<summary><b>Storage, model calls, and execution permissions</b></summary>

- **Local storage:** Materials, conversations, and model credentials are saved in `.runtime/data/` by default. Change `dataDir` in `.runtime/config.jsonc` to use another location. Back up the entire data directory.
- **Advanced configuration**: installation creates `.runtime/config.jsonc` from the [version-controlled default template](config.default.jsonc) without overwriting an existing file. Skills, prompts, and HTML templates are installed from Git sources into `.runtime/templates/` and refreshed on reinstall; edit their source files for lasting changes. Edit the runtime configuration to override storage/environment/temp directories, file limits, timeouts, retries and OCR device, then restart. Run `node src/server/config.mjs --defaults` for all defaults, or `node src/server/config.mjs` for resolved paths. Relative paths use the project root; Use `APP_CONFIG_FILE` only to select another configuration file. Changing paths does not move existing data or environments.
- **Model calls:** When using a cloud service, relevant context is sent to the provider you choose.
- **Personal use:** No platform account is required. The workbench listens on the loopback interface by default. The agent can access files and programs permitted by the account running it.

</details>

## Contributing

Share your research workflows, report usability issues, or contribute code. Please submit questions and suggestions through [Issues](https://github.com/hxaxd/hxaxd-research/issues).

<p align="center">
  <a href="LICENSE">MIT License</a> &nbsp;·&nbsp; © 2026 hxaxd
</p>
