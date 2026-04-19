// Canonical Cambridge curriculum option tree.
//
// The assessment builder needs four chained dropdowns — Syllabus (exam body) →
// Level → Subject → Topics — and every option must be available immediately,
// without waiting for an AI-extraction pass over the PDFs in /curriculum-docs.
// This module is the hand-curated source of truth for those dropdowns. It
// mirrors the subjects present in curriculum-docs/cambridge/syllabi/IGCSE and
// /A_Level, and each subject declares its top-level syllabus sections as
// pickable topics (e.g. Mathematics → "Linear graphs", "Mensuration",
// "Trigonometry").
//
// Topics are intentionally top-level sections of each published syllabus, not
// granular learning objectives — tutors pick one or more broad areas and the
// Co-Pilot prompt is scoped accordingly. A later AI-extraction pass can
// augment this list with subtopics; until then the UI is fully usable.
//
// Adding a new exam body (IB, Edexcel, AQA, …) is a matter of extending the
// top-level record: shape is always `board → level → subject → topics[]`.
//
// Subject names match the canonical `STANDARDIZED_SUBJECTS` list in
// shared/schema so the quiz row's `subject` column stays consistent.

export interface SeedTopic {
  topic: string;
  subtopics?: string[];
}

export interface CurriculumOptionTree {
  boards: string[];
  levels: Record<string, string[]>;                 // board → levels
  subjects: Record<string, string[]>;               // `${board}|${level}` → subjects
  topics: Record<string, SeedTopic[]>;              // `${board}|${level}|${subject}` → topics
}

// ── Cambridge IGCSE ──────────────────────────────────────────────────────────
const cambridgeIgcse: Record<string, SeedTopic[]> = {
  "Mathematics": [
    { topic: "Number" },
    { topic: "Algebra and graphs" },
    { topic: "Coordinate geometry" },
    { topic: "Geometry" },
    { topic: "Mensuration" },
    { topic: "Trigonometry" },
    { topic: "Transformations and vectors" },
    { topic: "Statistics" },
    { topic: "Probability" },
  ],
  "Physics": [
    { topic: "Motion, forces and energy" },
    { topic: "Thermal physics" },
    { topic: "Waves" },
    { topic: "Electricity and magnetism" },
    { topic: "Nuclear physics" },
    { topic: "Space physics" },
  ],
  "Chemistry": [
    { topic: "States of matter" },
    { topic: "Atoms, elements and compounds" },
    { topic: "Stoichiometry" },
    { topic: "Electrochemistry" },
    { topic: "Chemical energetics" },
    { topic: "Chemical reactions" },
    { topic: "Acids, bases and salts" },
    { topic: "The Periodic Table" },
    { topic: "Metals" },
    { topic: "Chemistry of the environment" },
    { topic: "Organic chemistry" },
    { topic: "Experimental techniques and chemical analysis" },
  ],
  "Biology": [
    { topic: "Characteristics and classification of living organisms" },
    { topic: "Organisation of the organism" },
    { topic: "Movement into and out of cells" },
    { topic: "Biological molecules" },
    { topic: "Enzymes" },
    { topic: "Plant nutrition" },
    { topic: "Human nutrition" },
    { topic: "Transport in plants" },
    { topic: "Transport in animals" },
    { topic: "Diseases and immunity" },
    { topic: "Gas exchange in humans" },
    { topic: "Respiration" },
    { topic: "Excretion in humans" },
    { topic: "Coordination and response" },
    { topic: "Drugs" },
    { topic: "Reproduction" },
    { topic: "Inheritance" },
    { topic: "Variation and selection" },
    { topic: "Organisms and their environment" },
    { topic: "Human influences on ecosystems" },
    { topic: "Biotechnology and genetic modification" },
  ],
  "Economics": [
    { topic: "The basic economic problem" },
    { topic: "The allocation of resources" },
    { topic: "Microeconomic decision makers" },
    { topic: "Government and the macroeconomy" },
    { topic: "Economic development" },
    { topic: "International trade and globalisation" },
  ],
  "Business Studies": [
    { topic: "Understanding business activity" },
    { topic: "People in business" },
    { topic: "Marketing" },
    { topic: "Operations management" },
    { topic: "Financial information and decisions" },
    { topic: "External influences on business activity" },
  ],
  "Accounting": [
    { topic: "The fundamentals of accounting" },
    { topic: "Sources and recording of data" },
    { topic: "Verification of accounting records" },
    { topic: "Accounting procedures" },
    { topic: "Preparation of financial statements" },
    { topic: "Analysis and interpretation" },
    { topic: "Accounting principles and policies" },
  ],
  "Computer Science": [
    { topic: "Data representation" },
    { topic: "Data transmission" },
    { topic: "Hardware" },
    { topic: "Software" },
    { topic: "The internet and its uses" },
    { topic: "Automated and emerging technologies" },
    { topic: "Algorithm design and problem-solving" },
    { topic: "Programming" },
    { topic: "Databases" },
    { topic: "Boolean logic" },
  ],
  "Geography": [
    { topic: "Population and settlement" },
    { topic: "The natural environment" },
    { topic: "Economic development" },
    { topic: "Geographical skills and investigations" },
  ],
  "History": [
    { topic: "The 19th century: the development of modern nation states, 1848–1914" },
    { topic: "The 20th century: international relations since 1919" },
    { topic: "Depth study" },
  ],
  "English": [
    { topic: "Reading" },
    { topic: "Writing" },
    { topic: "Directed writing" },
    { topic: "Composition" },
  ],
};

// Additional Mathematics is a separate IGCSE syllabus (0606) — it isn't in
// STANDARDIZED_SUBJECTS but tutors often teach it alongside Mathematics, so we
// expose it under the "Mathematics" subject slot with its own topic set when
// the tutor specifically wants Additional Math. For simplicity we fold its
// topics into the IGCSE Mathematics list's extended set; a dedicated subject
// slot can be added later if tutors ask for one.

// ── Cambridge A Level (covers AS + A2) ───────────────────────────────────────
const cambridgeALevel: Record<string, SeedTopic[]> = {
  "Mathematics": [
    // Pure Mathematics 1 (AS)
    { topic: "Quadratics" },
    { topic: "Functions" },
    { topic: "Coordinate geometry" },
    { topic: "Circular measure" },
    { topic: "Trigonometry" },
    { topic: "Series" },
    { topic: "Differentiation" },
    { topic: "Integration" },
    // Pure Mathematics 2 & 3 (A2)
    { topic: "Algebra" },
    { topic: "Logarithmic and exponential functions" },
    { topic: "Numerical solution of equations" },
    { topic: "Vectors" },
    { topic: "Differential equations" },
    { topic: "Complex numbers" },
    // Mechanics
    { topic: "Forces and equilibrium" },
    { topic: "Kinematics of motion in a straight line" },
    { topic: "Momentum" },
    { topic: "Newton's laws of motion" },
    { topic: "Energy, work and power" },
    // Probability & Statistics
    { topic: "Representation of data" },
    { topic: "Permutations and combinations" },
    { topic: "Probability" },
    { topic: "Discrete random variables" },
    { topic: "The normal distribution" },
    { topic: "Hypothesis testing" },
  ],
  "Physics": [
    { topic: "Physical quantities and units" },
    { topic: "Kinematics" },
    { topic: "Dynamics" },
    { topic: "Forces, density and pressure" },
    { topic: "Work, energy and power" },
    { topic: "Deformation of solids" },
    { topic: "Waves" },
    { topic: "Superposition" },
    { topic: "Electricity" },
    { topic: "D.C. circuits" },
    { topic: "Particle physics" },
    { topic: "Motion in a circle" },
    { topic: "Gravitational fields" },
    { topic: "Temperature" },
    { topic: "Ideal gases" },
    { topic: "Thermodynamics" },
    { topic: "Oscillations" },
    { topic: "Electric fields" },
    { topic: "Capacitance" },
    { topic: "Magnetic fields" },
    { topic: "Alternating currents" },
    { topic: "Quantum physics" },
    { topic: "Nuclear physics" },
    { topic: "Medical physics" },
    { topic: "Astronomy and cosmology" },
  ],
  "Chemistry": [
    { topic: "Atomic structure" },
    { topic: "Atoms, molecules and stoichiometry" },
    { topic: "Chemical bonding" },
    { topic: "States of matter" },
    { topic: "Chemical energetics" },
    { topic: "Electrochemistry" },
    { topic: "Equilibria" },
    { topic: "Reaction kinetics" },
    { topic: "The Periodic Table: chemical periodicity" },
    { topic: "Group 2" },
    { topic: "Group 17" },
    { topic: "Nitrogen and sulfur" },
    { topic: "Introduction to organic chemistry" },
    { topic: "Hydrocarbons" },
    { topic: "Halogen compounds" },
    { topic: "Hydroxy compounds" },
    { topic: "Carbonyl compounds" },
    { topic: "Carboxylic acids and derivatives" },
    { topic: "Nitrogen compounds" },
    { topic: "Polymerisation" },
    { topic: "Organic synthesis" },
    { topic: "Analytical techniques" },
  ],
  "Biology": [
    { topic: "Cell structure" },
    { topic: "Biological molecules" },
    { topic: "Enzymes" },
    { topic: "Cell membranes and transport" },
    { topic: "The mitotic cell cycle" },
    { topic: "Nucleic acids and protein synthesis" },
    { topic: "Transport in plants" },
    { topic: "Transport in mammals" },
    { topic: "Gas exchange" },
    { topic: "Infectious diseases" },
    { topic: "Immunity" },
    { topic: "Energy and respiration" },
    { topic: "Photosynthesis" },
    { topic: "Homeostasis" },
    { topic: "Control and coordination" },
    { topic: "Inheritance" },
    { topic: "Selection and evolution" },
    { topic: "Classification, biodiversity and conservation" },
    { topic: "Genetic technology" },
  ],
  "Economics": [
    { topic: "Basic economic ideas and resource allocation" },
    { topic: "The price system and the microeconomy" },
    { topic: "Government microeconomic intervention" },
    { topic: "The macroeconomy" },
    { topic: "Government macroeconomic intervention" },
    { topic: "International economic issues" },
  ],
  "Business Studies": [
    { topic: "Business and its environment" },
    { topic: "People in organisations" },
    { topic: "Marketing" },
    { topic: "Operations and project management" },
    { topic: "Finance and accounting" },
    { topic: "Strategic management" },
  ],
  "Accounting": [
    { topic: "The accounting system" },
    { topic: "Financial accounting" },
    { topic: "Financial reporting and interpretation" },
    { topic: "Elements of managerial accounting" },
    { topic: "Cost and management accounting" },
    { topic: "Budgeting and budgetary control" },
    { topic: "Investment appraisal" },
  ],
  "Computer Science": [
    { topic: "Information representation" },
    { topic: "Communication" },
    { topic: "Hardware" },
    { topic: "Processor fundamentals" },
    { topic: "System software" },
    { topic: "Security, privacy and data integrity" },
    { topic: "Ethics and ownership" },
    { topic: "Databases" },
    { topic: "Algorithm design and problem-solving" },
    { topic: "Data types and structures" },
    { topic: "Programming" },
    { topic: "Software development" },
    { topic: "Boolean algebra and logic circuits" },
    { topic: "Artificial intelligence" },
    { topic: "Further programming" },
  ],
  "Geography": [
    { topic: "Hydrology and fluvial geomorphology" },
    { topic: "Atmosphere and weather" },
    { topic: "Rocks and weathering" },
    { topic: "Population" },
    { topic: "Migration" },
    { topic: "Settlement dynamics" },
    { topic: "Tropical environments" },
    { topic: "Coastal environments" },
    { topic: "Hazardous environments" },
    { topic: "Hot arid and semi-arid environments" },
    { topic: "Production, location and change" },
    { topic: "Environmental management" },
    { topic: "Global interdependence" },
    { topic: "Economic transition" },
  ],
  "History": [
    { topic: "European history in the interwar years, 1919–41" },
    { topic: "International relations, 1871–1945" },
    { topic: "International history, 1945–91" },
    { topic: "The history of the USA, 1820–1941" },
    { topic: "African and Asian history" },
  ],
  "English": [
    { topic: "Reading" },
    { topic: "Writing" },
    { topic: "Language analysis" },
    { topic: "Text and discourse analysis" },
    { topic: "Language topics" },
  ],
};

// ── Option tree assembly ─────────────────────────────────────────────────────
export const CAMBRIDGE_CURRICULUM_SEED: CurriculumOptionTree = (() => {
  const boards = ["Cambridge"];
  const levels: Record<string, string[]> = {
    Cambridge: ["IGCSE", "A Level"],
  };
  const subjects: Record<string, string[]> = {};
  const topics: Record<string, SeedTopic[]> = {};

  const register = (board: string, level: string, bank: Record<string, SeedTopic[]>) => {
    const subjectNames = Object.keys(bank).sort((a, b) => a.localeCompare(b));
    subjects[`${board}|${level}`] = subjectNames;
    for (const subject of subjectNames) {
      topics[`${board}|${level}|${subject}`] = bank[subject];
    }
  };

  register("Cambridge", "IGCSE", cambridgeIgcse);
  register("Cambridge", "A Level", cambridgeALevel);

  return { boards, levels, subjects, topics };
})();

export function getCurriculumOptions(): CurriculumOptionTree {
  return CAMBRIDGE_CURRICULUM_SEED;
}

export function getSeedTopicsFor(board: string, level: string, subject: string): SeedTopic[] {
  return CAMBRIDGE_CURRICULUM_SEED.topics[`${board}|${level}|${subject}`] ?? [];
}
