# SOMA — Intelligent Assessment Platform

## Overview
SOMA is a full-stack intelligent assessment platform designed for educational purposes. It enables students to take interactive MCQ quizzes featuring LaTeX-rendered mathematical notation. Tutors can manage students, create quizzes efficiently with an AI copilot, and access comprehensive analytics. Super administrators have global oversight and management capabilities. The platform exclusively utilizes the modern Soma pipeline, having completely retired all legacy quiz infrastructure. The business vision is to revolutionize educational assessment through AI-powered tools, providing a streamlined and intelligent experience for students and educators alike.

## User Preferences
I want the agent to focus on completing the assigned tasks.
I prefer to use a modern and efficient development workflow.
I appreciate clear and concise communication.
I want the agent to use proper Markdown formatting for all text.

## System Architecture

### UI/UX Decisions
The frontend employs React (Vite), Tailwind CSS, and Shadcn UI for a modern, responsive user experience. React-katex handles LaTeX rendering for mathematical expressions. Glassmorphism UI elements are used in key areas such as student authentication and the tutor dashboard. The tutor dashboard is plaque-first, featuring interactive student plaques with flip animations and detailed insights. Subject-specific color and icon utilities enhance visual organization.

### Technical Implementations
The application is built with a React frontend and a Node.js/Express backend. Data persistence is managed by PostgreSQL with Drizzle ORM. Authentication is handled by Supabase Auth, integrating seamlessly with the `soma_users` table. Routing is managed by wouter. The platform implements Role-Based Access Control (RBAC) with `student`, `tutor`, and `super_admin` roles. A key feature is the AI Copilot for quiz generation, which uses a draft architecture, allowing AI to suggest questions into an in-memory draft before explicit saving and publishing to `soma_questions`. Math rendering uses `MarkdownRenderer` (ReactMarkdown + remark-math + rehype-katex) to consistently display LaTeX. Graph plotting is handled by the `GraphPlot` component, ensuring unique IDs for SVG elements and graceful fallbacks for invalid specifications.

### Feature Specifications
- **Soma Quiz Engine**: Interactive student quiz interface supporting LaTeX, option selection, and a summary view.
- **Soma Quiz Review**: Post-quiz review with explanations, correct/incorrect indicators, and AI feedback.
- **Tutor Portal**: A "Command Centre" dashboard with KPIs, AI-powered intervention queues, review queues, subject performance charts, and student management tools. Student profiles offer diagnostic workspaces, academic summaries, and private notes.
- **AI Dashboard Intelligence**: Provides AI-powered intervention insights for at-risk students and generates academic summaries (narratives, weaknesses, next steps) based on assessment data.
- **Syllabus Grounding**: AI generation is grounded in syllabus PDFs stored locally in the workspace.
- **Super Admin Dashboard**: Global user and quiz management with data tables and hard delete capabilities.
- **Auth System**: Unified `/login` route for all users (students and tutors) with tab-based switching for login, signup, and forgot-password. Improved inline error handling for authentication failures.
- **Assignment Feedback**: Provides clear feedback on quiz assignment outcomes, differentiating successful assignments from already assigned statuses.

### System Design Choices
The backend features an `aiOrchestrator` for dynamic AI model fallback (GPT-4o primary, with Claude, Gemini, o3-mini, DeepSeek, and GPT-4o-mini as fallbacks). A "Maker-Checker" pipeline (`aiPipeline.ts`) ensures robust AI content generation. The database schema is streamlined to exclusively support Soma operations, eliminating legacy tables. All API endpoints are clearly defined and adhere to an authentication and authorization scheme.

## External Dependencies
- **Auth**: Supabase Auth
- **AI/LLM Providers**:
    - Google Generative AI (Gemini)
    - Anthropic AI SDK (Claude)
    - OpenAI (GPT-4o, GPT-4o-mini)
    - DeepSeek
- **Database**: PostgreSQL
- **ORM**: Drizzle ORM
- **Frontend Libraries**:
    - React
    - Vite
    - Tailwind CSS
    - Shadcn UI
    - react-katex
    - DOMPurify
    - wouter (for routing)
- **Backend Libraries**:
    - Node.js
    - Express
    - multer (for file uploads)