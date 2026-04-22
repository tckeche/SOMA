/**
 * Curriculum content module.
 *
 * Provides built-in syllabus topic lists and examiner-style "things to remember"
 * reminders for the student dashboard. These act as a deterministic fallback
 * when the database tables (`syllabus_topic_inventory`, `examiner_misconceptions`)
 * are empty, and they ensure the AS / A2 / IGCSE level distinction is always
 * respected.
 *
 * Each subject is keyed by a normalized lowercase subject name. AS and A2
 * intentionally have separate topic lists so a student studying AS sees only
 * AS-level topics, and likewise for A2. IGCSE follows the same convention.
 *
 * Reminders are short, written in a tutoring tone ("Many students forget... ",
 * "A common mistake is..."), and capped to three sentences as required.
 */

export type CurriculumLevel = "AS" | "A2" | "IGCSE";

export interface CurriculumTopic {
  topic: string;
  subtopic?: string;
  description?: string;
}

export interface CurriculumReminder {
  id: string;
  topic: string;
  text: string;
}

interface SubjectContent {
  topics: CurriculumTopic[];
  reminders: CurriculumReminder[];
}

const NORMALIZE_REPLACEMENTS: Array<[RegExp, string]> = [
  [/&/g, "and"],
  [/business\s+studies/i, "business"],
  [/further\s+maths/i, "further mathematics"],
  [/pure\s+(maths|mathematics)/i, "mathematics"],
  [/additional\s+(maths|mathematics)/i, "mathematics"],
  [/(?<!further\s)maths\b/i, "mathematics"],
  [/computer\s+science/i, "computer science"],
];

export function normalizeSubject(subject: string): string {
  let s = subject.trim().toLowerCase();
  for (const [pattern, replacement] of NORMALIZE_REPLACEMENTS) {
    s = s.replace(pattern, replacement);
  }
  return s.replace(/\s+/g, " ").trim();
}

export function normalizeLevel(rawLevel: string | null | undefined): CurriculumLevel | null {
  if (!rawLevel) return null;
  const lvl = rawLevel.trim().toLowerCase();
  if (lvl === "a2" || lvl === "a level" || lvl === "a-level" || lvl === "alevel") return "A2";
  if (lvl === "as" || lvl === "as level" || lvl === "as-level") return "AS";
  if (lvl.includes("igcse") || lvl.includes("gcse")) return "IGCSE";
  if (lvl.startsWith("a2")) return "A2";
  if (lvl.startsWith("as")) return "AS";
  return null;
}

/**
 * Pick the strongest level a student is studying for a given subject.
 * If they have any A2-level quizzes/subjects we return A2, otherwise AS, otherwise IGCSE.
 */
export function pickEffectiveLevel(levels: Array<string | null | undefined>): CurriculumLevel | null {
  const normalized = levels.map(normalizeLevel).filter((l): l is CurriculumLevel => l !== null);
  if (normalized.includes("A2")) return "A2";
  if (normalized.includes("AS")) return "AS";
  if (normalized.includes("IGCSE")) return "IGCSE";
  return null;
}

const MATHEMATICS_AS: SubjectContent = {
  topics: [
    { topic: "Quadratics", description: "Completing the square, discriminant, quadratic graphs." },
    { topic: "Functions", description: "Domain, range, inverses and composite functions." },
    { topic: "Coordinate Geometry", description: "Straight lines, gradients and circles." },
    { topic: "Circular Measure", description: "Radians, arc length, sector area." },
    { topic: "Trigonometry", description: "Trig identities, equations and graphs." },
    { topic: "Series", description: "Arithmetic, geometric and binomial expansions." },
    { topic: "Differentiation", description: "Rules of differentiation, stationary points, gradients." },
    { topic: "Integration", description: "Indefinite and definite integrals, areas under curves." },
  ],
  reminders: [
    { id: "as-math-1", topic: "Differentiation", text: "Many students forget to set the derivative equal to zero when finding stationary points. Remember: dy/dx = 0 first, then test the second derivative for max or min." },
    { id: "as-math-2", topic: "Trigonometry", text: "A very common mistake is using degrees when the question is in radians. Always check the mode on your calculator before you start." },
    { id: "as-math-3", topic: "Quadratics", text: "Most students rush past the discriminant. Remember b² − 4ac < 0 means no real roots, = 0 means one repeated root." },
    { id: "as-math-4", topic: "Integration", text: "Don't forget the +C on every indefinite integral. It's one of the easiest marks to lose." },
    { id: "as-math-5", topic: "Coordinate Geometry", text: "When two lines are perpendicular, their gradients multiply to −1. Many students forget the negative sign." },
    { id: "as-math-6", topic: "Series", text: "For the binomial expansion, double-check whether the question wants ascending powers of x. Reading carefully here saves easy marks." },
  ],
};

const MATHEMATICS_A2: SubjectContent = {
  topics: [
    { topic: "Algebra", description: "Partial fractions, polynomial division, modulus." },
    { topic: "Logarithms and Exponentials", description: "ln, e^x, exponential models." },
    { topic: "Trigonometry", description: "Compound and double-angle formulae, R sin/cos form." },
    { topic: "Differentiation", description: "Product, quotient and chain rule, implicit and parametric." },
    { topic: "Integration", description: "By substitution, by parts, partial fractions." },
    { topic: "Numerical Methods", description: "Iteration, change of sign, Newton-Raphson." },
    { topic: "Vectors", description: "Lines in 3D, scalar product, intersections." },
    { topic: "Differential Equations", description: "First-order separable equations and modelling." },
  ],
  reminders: [
    { id: "a2-math-1", topic: "Integration", text: "When integrating by parts, choose u using LIATE so the result simplifies. Many students pick the wrong u and end up going in circles." },
    { id: "a2-math-2", topic: "Trigonometry", text: "Double-angle identities are tested every paper. Remember cos2x has three forms — pick the one that matches what's already in the equation." },
    { id: "a2-math-3", topic: "Differentiation", text: "For implicit differentiation, every y term gets a dy/dx attached. A common mistake is forgetting it on the y² terms." },
    { id: "a2-math-4", topic: "Vectors", text: "When finding the angle between two lines, use the direction vectors only, not the position vectors. Students often confuse the two." },
    { id: "a2-math-5", topic: "Logarithms and Exponentials", text: "ln(a) + ln(b) = ln(ab), not ln(a+b). This single slip costs marks every year." },
    { id: "a2-math-6", topic: "Differential Equations", text: "After separating the variables, don't forget the constant of integration before applying boundary conditions. It changes the final answer." },
  ],
};

const MATHEMATICS_IGCSE: SubjectContent = {
  topics: [
    { topic: "Number", description: "Fractions, decimals, percentages, surds and indices." },
    { topic: "Algebra", description: "Manipulation, equations, inequalities and sequences." },
    { topic: "Mensuration", description: "Areas, volumes, arc length and sector area." },
    { topic: "Coordinate Geometry", description: "Straight lines, gradient and midpoint." },
    { topic: "Trigonometry", description: "Right-angled triangles and sine and cosine rules." },
    { topic: "Statistics", description: "Averages, frequency tables and cumulative frequency." },
    { topic: "Probability", description: "Tree diagrams, mutually exclusive and independent events." },
    { topic: "Vectors and Transformations", description: "Column vectors, translation, rotation, reflection, enlargement." },
  ],
  reminders: [
    { id: "ig-math-1", topic: "Algebra", text: "When solving an inequality, flip the sign whenever you multiply or divide by a negative. Easy to forget under exam pressure." },
    { id: "ig-math-2", topic: "Trigonometry", text: "Use SOH CAH TOA only for right-angled triangles. For other triangles, switch to the sine or cosine rule." },
    { id: "ig-math-3", topic: "Probability", text: "On a tree diagram, multiply along the branches and add between branches. A very common mistake is doing it the other way around." },
    { id: "ig-math-4", topic: "Mensuration", text: "Always include units in your final answer. Many students lose easy marks by writing just a number." },
    { id: "ig-math-5", topic: "Statistics", text: "On a cumulative frequency curve, the median is read at n/2, not n/2 + 0.5. Read carefully." },
  ],
};

const PHYSICS_AS: SubjectContent = {
  topics: [
    { topic: "Physical Quantities and Units", description: "SI units, scalars, vectors, errors and uncertainties." },
    { topic: "Kinematics", description: "Motion graphs, equations of motion, projectiles." },
    { topic: "Dynamics", description: "Newton's laws, momentum, conservation." },
    { topic: "Forces, Density and Pressure", description: "Equilibrium, moments, fluid pressure." },
    { topic: "Work, Energy and Power", description: "Work done, energy conservation, efficiency." },
    { topic: "Waves", description: "Transverse and longitudinal waves, superposition, interference." },
    { topic: "Electricity", description: "Current, voltage, resistance, Kirchhoff's laws." },
    { topic: "Particle Physics", description: "Atomic structure, quarks, fundamental particles." },
  ],
  reminders: [
    { id: "as-phys-1", topic: "Kinematics", text: "Always write down the suvat values and which one you are solving for. Most marks are lost when students skip this step and pick the wrong equation." },
    { id: "as-phys-2", topic: "Forces, Density and Pressure", text: "When taking moments, the pivot must be clearly stated. A common mistake is forgetting to include the weight of the beam itself." },
    { id: "as-phys-3", topic: "Electricity", text: "Voltmeters go in parallel, ammeters go in series. Many students draw these the wrong way around in circuit diagrams." },
    { id: "as-phys-4", topic: "Waves", text: "Path difference for constructive interference is nλ, for destructive it's (n + ½)λ. Mixing these up is the most common error in this topic." },
    { id: "as-phys-5", topic: "Physical Quantities and Units", text: "Always check the unit of your final answer. If you're working in cm and the answer wants metres, you'll lose the mark even with correct working." },
  ],
};

const PHYSICS_A2: SubjectContent = {
  topics: [
    { topic: "Circular Motion", description: "Angular velocity, centripetal force." },
    { topic: "Gravitational Fields", description: "Newton's law, gravitational potential, orbits." },
    { topic: "Oscillations", description: "Simple harmonic motion, damping and resonance." },
    { topic: "Thermal Physics", description: "Internal energy, ideal gas, kinetic theory." },
    { topic: "Electric Fields", description: "Coulomb's law, capacitors, energy storage." },
    { topic: "Magnetic Fields", description: "Force on a current, electromagnetic induction." },
    { topic: "Quantum Physics", description: "Photon energy, photoelectric effect, energy levels." },
    { topic: "Nuclear Physics", description: "Decay, half-life, mass-energy equivalence." },
  ],
  reminders: [
    { id: "a2-phys-1", topic: "Circular Motion", text: "The centripetal force is the resultant of all forces acting toward the centre. Many students try to add it as an extra force, which is wrong." },
    { id: "a2-phys-2", topic: "Capacitors", text: "When capacitors are in series, capacitance adds like resistors in parallel. Mixing these up is one of the most common slips." },
    { id: "a2-phys-3", topic: "Quantum Physics", text: "For the photoelectric effect, intensity affects the number of electrons but not their kinetic energy. Frequency does the opposite. Don't confuse the two." },
    { id: "a2-phys-4", topic: "Nuclear Physics", text: "Half-life is the time for activity to halve, not for the substance to disappear. After 3 half-lives there's still 12.5% left." },
    { id: "a2-phys-5", topic: "Magnetic Fields", text: "Use Fleming's left-hand rule for the force on a current, and the right-hand rule for induced current. A very common mix-up." },
  ],
};

const CHEMISTRY_AS: SubjectContent = {
  topics: [
    { topic: "Atomic Structure", description: "Subatomic particles, isotopes, electron configuration." },
    { topic: "Atoms, Molecules and Stoichiometry", description: "Mole calculations, empirical formula." },
    { topic: "Chemical Bonding", description: "Ionic, covalent, metallic bonding, intermolecular forces." },
    { topic: "States of Matter", description: "Gas laws, ideal gas equation." },
    { topic: "Chemical Energetics", description: "Enthalpy changes, Hess's law, bond energies." },
    { topic: "Electrochemistry", description: "Redox, oxidation numbers, electrolysis." },
    { topic: "Equilibria", description: "Le Chatelier, Kc, acid–base equilibria." },
    { topic: "Organic Chemistry", description: "Alkanes, alkenes, halogenoalkanes, alcohols." },
  ],
  reminders: [
    { id: "as-chem-1", topic: "Stoichiometry", text: "Always balance the equation before doing any mole calculations. Most students who lose marks here forgot to balance first." },
    { id: "as-chem-2", topic: "Chemical Bonding", text: "When drawing dot-and-cross diagrams, only show the outer shell. Including inner shells is a common mistake that costs marks." },
    { id: "as-chem-3", topic: "Energetics", text: "Enthalpy change is products minus reactants. Many students do reactants minus products and get the sign wrong." },
    { id: "as-chem-4", topic: "Organic Chemistry", text: "When naming organic compounds, the lowest locant rule applies to the whole chain. A common mistake is numbering from the wrong end." },
    { id: "as-chem-5", topic: "Equilibria", text: "Le Chatelier predicts the direction of shift, not the size. Don't write that 'all the products form' — that's not what equilibrium means." },
  ],
};

const CHEMISTRY_A2: SubjectContent = {
  topics: [
    { topic: "Lattice Energy", description: "Born-Haber cycles, factors affecting lattice energy." },
    { topic: "Reaction Kinetics", description: "Rate equations, half-life, order of reaction." },
    { topic: "Equilibria", description: "Kp, partial pressures, buffer solutions." },
    { topic: "Acids, Bases and Buffers", description: "pH, Ka, titration curves." },
    { topic: "Transition Elements", description: "Oxidation states, complex ions, ligands." },
    { topic: "Organic Chemistry", description: "Carbonyls, carboxylic acids, amines, polymers." },
    { topic: "Spectroscopy", description: "Mass spec, IR, NMR." },
    { topic: "Analytical Chemistry", description: "Chromatography, electrophoresis." },
  ],
  reminders: [
    { id: "a2-chem-1", topic: "Buffers", text: "A buffer needs a weak acid and its conjugate base in similar amounts. Many students forget the second part and just write 'a weak acid'." },
    { id: "a2-chem-2", topic: "Reaction Kinetics", text: "The order of a reaction can only be found from experimental data, not from the balanced equation. This is a classic exam trap." },
    { id: "a2-chem-3", topic: "Transition Elements", text: "When ligands change, the colour of the complex usually changes too. Always state the colour change in full — initial and final." },
    { id: "a2-chem-4", topic: "Spectroscopy", text: "On a mass spectrum, the molecular ion peak is at the highest m/z, not the tallest peak. Many students confuse these." },
    { id: "a2-chem-5", topic: "Organic Chemistry", text: "Carboxylic acids are weak acids — they don't fully ionise. Don't write a single arrow in the dissociation equation." },
  ],
};

const BIOLOGY_AS: SubjectContent = {
  topics: [
    { topic: "Cell Structure", description: "Eukaryotic and prokaryotic cells, organelles." },
    { topic: "Biological Molecules", description: "Carbohydrates, lipids, proteins, water." },
    { topic: "Enzymes", description: "Activation energy, factors affecting rate, inhibitors." },
    { topic: "Cell Membranes and Transport", description: "Diffusion, osmosis, active transport." },
    { topic: "Mitosis", description: "Cell cycle, chromosomes, cancer." },
    { topic: "Nucleic Acids and Protein Synthesis", description: "DNA, RNA, transcription, translation." },
    { topic: "Transport in Plants and Mammals", description: "Xylem, phloem, blood vessels, heart." },
    { topic: "Gas Exchange and Smoking", description: "Lungs, alveoli, ventilation." },
  ],
  reminders: [
    { id: "as-bio-1", topic: "Enzymes", text: "Enzymes lower the activation energy — they don't change the position of equilibrium. A very common misconception that loses marks." },
    { id: "as-bio-2", topic: "Cell Membranes and Transport", text: "Osmosis is the movement of water, not solutes. Always state water specifically when explaining osmosis." },
    { id: "as-bio-3", topic: "Protein Synthesis", text: "Transcription happens in the nucleus, translation in the cytoplasm at the ribosomes. Mixing these locations up is a common slip." },
    { id: "as-bio-4", topic: "Cell Structure", text: "Prokaryotic cells have no membrane-bound organelles. Many students still describe them with mitochondria — they don't have any." },
    { id: "as-bio-5", topic: "Mitosis", text: "Mitosis produces two genetically identical diploid cells, not four. That's meiosis. Always read the question carefully." },
  ],
};

const BIOLOGY_A2: SubjectContent = {
  topics: [
    { topic: "Energy and Respiration", description: "ATP, glycolysis, Krebs cycle, electron transport." },
    { topic: "Photosynthesis", description: "Light-dependent and light-independent stages." },
    { topic: "Homeostasis", description: "Negative feedback, kidneys, blood glucose control." },
    { topic: "Coordination", description: "Nervous system, hormones, plant responses." },
    { topic: "Inheritance", description: "Monohybrid, dihybrid, sex linkage, linkage." },
    { topic: "Selection and Evolution", description: "Natural selection, speciation, Hardy-Weinberg." },
    { topic: "Biodiversity, Classification and Conservation", description: "Species, ecosystems, conservation strategies." },
    { topic: "Genetic Technology", description: "PCR, gel electrophoresis, gene therapy." },
  ],
  reminders: [
    { id: "a2-bio-1", topic: "Respiration", text: "Most ATP from respiration is produced in oxidative phosphorylation, not glycolysis or the Krebs cycle. Know the rough split." },
    { id: "a2-bio-2", topic: "Inheritance", text: "When drawing a Punnett square, write the genotypes of the gametes, not the parents, on the outside. A small slip that loses marks." },
    { id: "a2-bio-3", topic: "Homeostasis", text: "Insulin lowers blood glucose, glucagon raises it. The two are easily confused — link insulin with 'in to cells'." },
    { id: "a2-bio-4", topic: "Selection and Evolution", text: "Natural selection acts on phenotypes, not genotypes directly. Many students get this the wrong way around." },
    { id: "a2-bio-5", topic: "Photosynthesis", text: "The light-dependent reaction needs water, the light-independent reaction needs CO2. Always state which reactant goes with which stage." },
  ],
};

const ECONOMICS_AS: SubjectContent = {
  topics: [
    { topic: "Basic Economic Ideas", description: "Scarcity, opportunity cost, PPC, markets." },
    { topic: "Price System", description: "Demand, supply, equilibrium, elasticities." },
    { topic: "Government Microeconomic Intervention", description: "Taxes, subsidies, price controls." },
    { topic: "Macroeconomic Measurement", description: "GDP, inflation, unemployment, balance of payments." },
    { topic: "AD/AS Analysis", description: "Aggregate demand, aggregate supply, equilibrium." },
    { topic: "International Economics", description: "Trade, exchange rates, protectionism." },
  ],
  reminders: [
    { id: "as-econ-1", topic: "Elasticities", text: "Price elasticity of demand is always negative for a normal good — drop the sign when interpreting the magnitude. This trips up many students." },
    { id: "as-econ-2", topic: "AD/AS Analysis", text: "Always show clearly whether AD or AS shifts on your diagram, and label the new equilibrium. Diagrams without labels score zero." },
    { id: "as-econ-3", topic: "Government Intervention", text: "A tax shifts the supply curve up by the amount of the tax, not the demand curve. A common mistake under exam pressure." },
    { id: "as-econ-4", topic: "Price System", text: "Equilibrium is where demand equals supply, not where they intersect 'visually'. Always show the working algebraically when asked." },
  ],
};

const ECONOMICS_A2: SubjectContent = {
  topics: [
    { topic: "Theory of the Firm", description: "Costs, revenues, profit maximisation, market structures." },
    { topic: "Government Microeconomic Intervention", description: "Externalities, public goods, regulation." },
    { topic: "Labour Market", description: "Wage determination, trade unions, minimum wage." },
    { topic: "Macroeconomic Theory and Policy", description: "Keynesian and classical schools, fiscal and monetary policy." },
    { topic: "Economic Growth and Development", description: "Growth strategies, sustainability, HDI." },
    { topic: "International Economics", description: "Trade theory, exchange rate systems, globalisation." },
  ],
  reminders: [
    { id: "a2-econ-1", topic: "Theory of the Firm", text: "Profit is maximised where marginal cost equals marginal revenue, not where average cost is lowest. A classic exam trap." },
    { id: "a2-econ-2", topic: "Externalities", text: "A negative externality means social cost is greater than private cost. Always reference the third party in your explanation." },
    { id: "a2-econ-3", topic: "Macroeconomic Policy", text: "Fiscal policy uses tax and spending; monetary policy uses interest rates and money supply. Don't mix the two up in essay answers." },
    { id: "a2-econ-4", topic: "International Economics", text: "Comparative advantage is about opportunity cost, not absolute productivity. Many students confuse the two." },
  ],
};

const ACCOUNTING_AS: SubjectContent = {
  topics: [
    { topic: "The Accounting System", description: "Double entry, ledgers, trial balance, books of prime entry." },
    { topic: "Accounting Concepts", description: "Going concern, accruals, consistency, prudence." },
    { topic: "Sole Trader Accounts", description: "Income statement, statement of financial position." },
    { topic: "Partnership Accounts", description: "Appropriation, capital and current accounts." },
    { topic: "Limited Company Accounts", description: "Share capital, reserves, dividends." },
    { topic: "Analysis of Financial Statements", description: "Profitability, liquidity, efficiency ratios." },
    { topic: "Costing", description: "Unit cost, job costing, marginal vs absorption." },
    { topic: "Budgeting", description: "Cash budgets, master budgets, variance analysis." },
  ],
  reminders: [
    { id: "as-acc-1", topic: "Ratios", text: "Always show the formula and the working. Bare numbers without the formula lose marks even if the answer is right." },
    { id: "as-acc-2", topic: "The Accounting System", text: "For every debit there is a credit — check the trial balance totals match before you continue." },
    { id: "as-acc-3", topic: "Partnership Accounts", text: "Interest on drawings is DEBITED to partners' current accounts, not credited. A common slip under pressure." },
  ],
};

const ACCOUNTING_A2: SubjectContent = {
  topics: [
    { topic: "Published Accounts", description: "IAS 1, statement of changes in equity, notes to accounts." },
    { topic: "Consolidated Accounts", description: "Group structure, goodwill, non-controlling interest." },
    { topic: "Statement of Cash Flows", description: "IAS 7, operating/investing/financing activities." },
    { topic: "Auditing and Stewardship", description: "Role of the auditor, audit report types." },
    { topic: "Standard Costing", description: "Material, labour and overhead variances." },
    { topic: "Activity Based Costing", description: "Cost drivers, pools, comparison with absorption." },
    { topic: "Investment Appraisal", description: "Payback, ARR, NPV, IRR." },
    { topic: "Business Purchase", description: "Valuing goodwill, acquisition accounting." },
  ],
  reminders: [
    { id: "a2-acc-1", topic: "Statement of Cash Flows", text: "Depreciation is added back in the operating section — it is a non-cash expense. Many students forget and lose easy marks." },
    { id: "a2-acc-2", topic: "Investment Appraisal", text: "NPV beats IRR for ranking projects. State this explicitly in evaluation answers to score analysis marks." },
  ],
};

const BUSINESS_AS: SubjectContent = {
  topics: [
    { topic: "Business and its Environment", description: "Enterprise, business structure, size, stakeholders." },
    { topic: "People in Organisations", description: "Management, leadership, motivation, HR." },
    { topic: "Marketing", description: "The marketing mix, market research, segmentation." },
    { topic: "Operations and Project Management", description: "Productivity, capacity, inventory, quality." },
    { topic: "Finance and Accounting", description: "Costs, revenues, break-even, cash flow forecasts." },
    { topic: "Strategic Management", description: "SWOT, PEST, objectives, decision trees." },
  ],
  reminders: [
    { id: "as-bus-1", topic: "Marketing", text: "Always relate the 4Ps back to the case-study business — generic answers rarely score beyond a level 2." },
    { id: "as-bus-2", topic: "Finance and Accounting", text: "Break-even in units = fixed costs ÷ (price − variable cost). Don't mix up total cost with variable cost in the denominator." },
  ],
};

const BUSINESS_A2: SubjectContent = {
  topics: [
    { topic: "Organisational Culture", description: "Types of culture, culture change, influences." },
    { topic: "Strategic Human Resource Management", description: "Workforce planning, performance management." },
    { topic: "Global Marketing", description: "Pan-global vs localised strategy, international markets." },
    { topic: "Operations Strategy", description: "Lean, Kaizen, TQM, outsourcing." },
    { topic: "Strategic Finance", description: "Investment appraisal, sources of finance." },
    { topic: "Strategic Choice and Implementation", description: "Ansoff, Porter's generic strategies, change management." },
  ],
  reminders: [
    { id: "a2-bus-1", topic: "Strategic Management", text: "Evaluation means a justified judgement, not another point. Use 'however' and weigh both sides before concluding." },
    { id: "a2-bus-2", topic: "Investment Appraisal", text: "For NPV, the year 0 cash flow is NOT discounted. Many students apply the discount factor and lose the mark." },
  ],
};

const COMPUTER_SCIENCE_AS: SubjectContent = {
  topics: [
    { topic: "Information Representation", description: "Binary, hexadecimal, floating point, character codes." },
    { topic: "Communication", description: "Networks, protocols, internet structure." },
    { topic: "Hardware", description: "Logic gates, CPU, memory, I/O devices." },
    { topic: "Processor Fundamentals", description: "Fetch-execute cycle, registers, assembly language." },
    { topic: "System Software", description: "Operating systems, compilers, interpreters." },
    { topic: "Security, Privacy and Data Integrity", description: "Encryption, authentication, backup strategies." },
    { topic: "Ethics and Ownership", description: "Copyright, professional codes of conduct." },
    { topic: "Databases", description: "Relational model, normalisation up to 3NF, SQL." },
    { topic: "Algorithm Design and Problem Solving", description: "Pseudocode, trace tables, structured programming." },
    { topic: "Data Types and Structures", description: "Arrays, records, linked lists, stacks, queues." },
    { topic: "Programming", description: "Iteration, selection, procedures/functions, file handling." },
    { topic: "Software Development", description: "Lifecycle, testing strategies, documentation." },
  ],
  reminders: [
    { id: "as-cs-1", topic: "Information Representation", text: "When converting two's complement, invert the bits and add one — don't flip sign by just changing the MSB." },
    { id: "as-cs-2", topic: "Databases", text: "A table in 2NF has no partial dependencies on a composite key. If there's no composite key, 1NF already satisfies 2NF." },
    { id: "as-cs-3", topic: "Algorithm Design and Problem Solving", text: "Trace tables need one column per variable AND one for any output. Missing the output column is a common slip." },
  ],
};

const COMPUTER_SCIENCE_A2: SubjectContent = {
  topics: [
    { topic: "Data Representation", description: "User-defined types, file organisation, records." },
    { topic: "Communication and Internet Technologies", description: "LAN/WAN, packet switching, TCP/IP stack." },
    { topic: "Hardware and Virtual Machines", description: "RISC vs CISC, parallel processing, virtualisation." },
    { topic: "System Software", description: "OS scheduling, memory management, interrupts." },
    { topic: "Security", description: "Asymmetric encryption, digital signatures, SSL/TLS." },
    { topic: "Artificial Intelligence", description: "Machine learning types, neural networks, expert systems." },
    { topic: "Computational Thinking and Problem Solving", description: "Abstraction, decomposition, recursion." },
    { topic: "Further Programming", description: "OOP, inheritance, polymorphism, exception handling." },
    { topic: "Software Development", description: "Algorithms: Dijkstra, A*, binary tree traversal." },
  ],
  reminders: [
    { id: "a2-cs-1", topic: "Artificial Intelligence", text: "Supervised learning needs labelled data, unsupervised does not. Always state the data type when describing an ML algorithm." },
    { id: "a2-cs-2", topic: "Further Programming", text: "Inheritance uses IS-A, composition uses HAS-A. Confusing these two is one of the easiest marks to lose in OOP questions." },
  ],
};

const ENGLISH_AS: SubjectContent = {
  topics: [
    { topic: "Reading and Analysis", description: "Unseen prose and poetry, textual evidence." },
    { topic: "Directed Writing", description: "Audience, purpose, form, register." },
    { topic: "Writing Skills", description: "Discursive, descriptive, narrative, argumentative." },
    { topic: "Text and Discourse Analysis", description: "Linguistic frameworks: lexis, syntax, pragmatics." },
    { topic: "Language Change", description: "Historical change, standardisation, attitudes." },
    { topic: "Child Language Acquisition", description: "Spoken and written development stages." },
  ],
  reminders: [
    { id: "as-eng-1", topic: "Text and Discourse Analysis", text: "Always link a linguistic feature to its effect — identifying 'an imperative' without effect rarely scores beyond AO1." },
    { id: "as-eng-2", topic: "Directed Writing", text: "Match the register to the brief. A formal report uses nominalisation; a blog uses first-person and contractions." },
  ],
};

const ENGLISH_A2: SubjectContent = {
  topics: [
    { topic: "Shakespeare and Drama", description: "Close analysis, staging, critical interpretations." },
    { topic: "Poetry and Prose", description: "Set texts, comparison, literary context." },
    { topic: "Unseen Comparison", description: "Comparative analysis of unseen extracts." },
    { topic: "Language and the Self", description: "Idiolect, sociolect, identity construction." },
    { topic: "English in the World", description: "Global English, World Englishes, pidgins and creoles." },
    { topic: "Language and Power", description: "Fairclough, instrumental and influential power." },
  ],
  reminders: [
    { id: "a2-eng-1", topic: "Shakespeare and Drama", text: "Reference AO5 (critical views) explicitly — integrate at least one named critic or school of thought per essay." },
    { id: "a2-eng-2", topic: "Language and Power", text: "Fairclough distinguishes instrumental (enforced) from influential (persuasive) power. Naming the theorist scores the AO3 mark." },
  ],
};

const GEOGRAPHY_AS: SubjectContent = {
  topics: [
    { topic: "Hydrology and Fluvial Geomorphology", description: "Drainage basins, river processes, landforms." },
    { topic: "Atmosphere and Weather", description: "Heat budget, circulation, weather systems." },
    { topic: "Rocks and Weathering", description: "Plate tectonics, weathering, mass movement." },
    { topic: "Population", description: "Distribution, change, structure, migration." },
    { topic: "Migration", description: "Push-pull, internal, international, impacts." },
    { topic: "Settlement Dynamics", description: "Urbanisation, urban structure, rural change." },
  ],
  reminders: [
    { id: "as-geo-1", topic: "Hydrology and Fluvial Geomorphology", text: "Always distinguish ERoSion (wearing away) from TRANSportation (movement). Exam reports flag this mix-up every year." },
    { id: "as-geo-2", topic: "Population", text: "DTM has 5 stages; most African LDCs sit in stage 2 or 3. Name a country at each stage to strengthen answers." },
  ],
};

const GEOGRAPHY_A2: SubjectContent = {
  topics: [
    { topic: "Tropical Environments", description: "Climate, ecosystems, management pressures." },
    { topic: "Coastal Environments", description: "Wave processes, landforms, management strategies." },
    { topic: "Hazardous Environments", description: "Tectonic, mass movement, atmospheric hazards." },
    { topic: "Arid and Semi-Arid Environments", description: "Processes, landforms, human use." },
    { topic: "Production, Location and Change", description: "Primary, secondary, tertiary, quaternary sectors." },
    { topic: "Environmental Management", description: "Sustainability, energy, resource management." },
    { topic: "Global Interdependence", description: "Trade, aid, debt, globalisation." },
    { topic: "Economic Transition", description: "NICs, transition economies, development indicators." },
  ],
  reminders: [
    { id: "a2-geo-1", topic: "Hazardous Environments", text: "Park's model = three phases (relief, rehab, reconstruction). Always annotate them on the response curve if drawn." },
    { id: "a2-geo-2", topic: "Global Interdependence", text: "HDI combines income, education and life expectancy — GDP alone is NOT a development indicator, it is an economic one." },
  ],
};

const HISTORY_AS: SubjectContent = {
  topics: [
    { topic: "European History 1789–1917", description: "French Revolution, Napoleon, unification of Germany and Italy, Russian Revolution." },
    { topic: "American History 1840–1877", description: "Manifest Destiny, Civil War causes, Reconstruction." },
    { topic: "International History 1870–1945", description: "Imperialism, WWI causes, interwar, WWII." },
    { topic: "African History 1800–1945", description: "Scramble for Africa, colonial rule, early nationalism." },
    { topic: "Source Analysis", description: "Utility, reliability, provenance, cross-referencing." },
  ],
  reminders: [
    { id: "as-hist-1", topic: "Source Analysis", text: "Utility = usefulness FOR THE QUESTION. A source can be biased AND useful — always explain both sides." },
    { id: "as-hist-2", topic: "European History 1789–1917", text: "Don't confuse causes of 1905 with causes of 1917. Economic grievances recur; the trigger events differ." },
  ],
};

const HISTORY_A2: SubjectContent = {
  topics: [
    { topic: "European History 1905–1989", description: "Russian Revolution, Stalin, Nazi Germany, Cold War Europe." },
    { topic: "American History 1865–2008", description: "Industrialisation, New Deal, civil rights, foreign policy." },
    { topic: "International History 1945–2000", description: "Cold War, decolonisation, Middle East, end of USSR." },
    { topic: "African History 1945–2000", description: "Decolonisation, post-independence politics, apartheid." },
    { topic: "Historiography", description: "Schools of interpretation, debates, changing views." },
  ],
  reminders: [
    { id: "a2-hist-1", topic: "Historiography", text: "Naming a historian is AO3, but ONLY if you explain their argument. 'Taylor says...' on its own earns zero." },
    { id: "a2-hist-2", topic: "International History 1945–2000", text: "The Cold War never turned hot DIRECTLY between the superpowers — proxy wars like Korea and Vietnam did. Stress this distinction." },
  ],
};

const FURTHER_MATHEMATICS_A2: SubjectContent = {
  topics: [
    { topic: "Further Pure Mathematics 1", description: "Roots of polynomials, matrices, vectors, complex numbers, proof." },
    { topic: "Further Pure Mathematics 2", description: "Hyperbolic functions, polar coordinates, differential equations, further integration." },
    { topic: "Further Mechanics", description: "Momentum, circular motion, equilibrium of rigid bodies, elastic strings." },
    { topic: "Further Probability and Statistics", description: "Continuous distributions, Poisson, chi-squared, non-parametric tests." },
  ],
  reminders: [
    { id: "fm-1", topic: "Further Pure Mathematics 1", text: "For matrix transformations, the order matters: AB applies B first, then A. Reversing this is the most common exam error." },
    { id: "fm-2", topic: "Further Mechanics", text: "When using impulse = change in momentum, both quantities are vectors. Always resolve along consistent axes before substituting." },
  ],
};

const SUBJECT_CONTENT: Record<string, Partial<Record<CurriculumLevel, SubjectContent>>> = {
  mathematics: { AS: MATHEMATICS_AS, A2: MATHEMATICS_A2, IGCSE: MATHEMATICS_IGCSE },
  "further mathematics": { A2: FURTHER_MATHEMATICS_A2 },
  physics: { AS: PHYSICS_AS, A2: PHYSICS_A2 },
  chemistry: { AS: CHEMISTRY_AS, A2: CHEMISTRY_A2 },
  biology: { AS: BIOLOGY_AS, A2: BIOLOGY_A2 },
  economics: { AS: ECONOMICS_AS, A2: ECONOMICS_A2 },
  accounting: { AS: ACCOUNTING_AS, A2: ACCOUNTING_A2 },
  business: { AS: BUSINESS_AS, A2: BUSINESS_A2 },
  "computer science": { AS: COMPUTER_SCIENCE_AS, A2: COMPUTER_SCIENCE_A2 },
  english: { AS: ENGLISH_AS, A2: ENGLISH_A2 },
  geography: { AS: GEOGRAPHY_AS, A2: GEOGRAPHY_A2 },
  history: { AS: HISTORY_AS, A2: HISTORY_A2 },
};

export function getCurriculumTopics(subject: string, level: CurriculumLevel | null): CurriculumTopic[] {
  if (!level) return [];
  const key = normalizeSubject(subject);
  const content = SUBJECT_CONTENT[key];
  return content?.[level]?.topics ?? [];
}

export function getCurriculumReminders(subject: string, level: CurriculumLevel | null): CurriculumReminder[] {
  if (!level) return [];
  const key = normalizeSubject(subject);
  const content = SUBJECT_CONTENT[key];
  return content?.[level]?.reminders ?? [];
}

/**
 * Compose a stable list of reminders for a student given their subjects and levels.
 * Items are deduplicated by id and lightly rotated based on the day so they
 * vary across visits without being random on every refresh.
 */
export function composeReminders(
  studentSubjectLevels: Array<{ subject: string; level: CurriculumLevel | null }>,
  options: { max?: number; seed?: number } = {},
): CurriculumReminder[] {
  const max = options.max ?? 8;
  const seed = options.seed ?? Math.floor(Date.now() / (1000 * 60 * 60 * 24));
  const seen = new Set<string>();
  const collected: Array<CurriculumReminder & { _subject: string }> = [];
  for (const entry of studentSubjectLevels) {
    if (!entry.subject || !entry.level) continue;
    const items = getCurriculumReminders(entry.subject, entry.level);
    for (const item of items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      collected.push({ ...item, _subject: entry.subject });
    }
  }
  if (collected.length === 0) return [];
  const offset = seed % collected.length;
  const rotated = [...collected.slice(offset), ...collected.slice(0, offset)];
  return rotated.slice(0, max).map(({ _subject, ...rest }) => ({ ...rest, topic: rest.topic, text: rest.text }));
}
