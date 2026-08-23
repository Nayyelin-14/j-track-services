import dotenv from "dotenv";
import { resolve } from "node:path";
dotenv.config({ path: resolve(process.cwd(), "../../.env") });
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcrypt";
import { v2 as cloudinary } from "cloudinary";

cloudinary.config({
  cloud_name: process.env.CLOUD_NAME,
  api_key: process.env.CLOUD_API_KEY,
  api_secret: process.env.CLOUD_API_SECRET,
});

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DB_URL! } },
});

const TEST_PASSWORD = "Test@12345";

const SKILLS = [
  "javascript",
  "typescript",
  "nodejs",
  "react",
  "python",
  "sql",
  "aws",
  "docker",
  "kubernetes",
  "kafka",
  "postgresql",
  "git",
  "circuit design",
  "ic layout",
  "cadence virtuoso",
  "analog design",
  "mixed-signal",
  "plc",
  "scada",
  "opc ua",
  "modbus",
  "microsoft project",
  "project management",
  "lean six sigma",
];

const JOBSEEKER_SKILLS: Record<string, string[]> = {
  "wichit.jobseeker1@jt-demo.com": ["javascript", "typescript", "nodejs", "postgresql", "docker", "kubernetes", "kafka", "aws"],
  "pimchanok.jobseeker2@jt-demo.com": ["circuit design", "ic layout", "cadence virtuoso", "analog design", "mixed-signal"],
  "krit.jobseeker3@jt-demo.com": ["plc", "scada", "opc ua", "modbus", "python"],
  "anongrat.jobseeker4@jt-demo.com": ["project management", "jira", "microsoft project", "lean six sigma", "sql"],
  "sarawut.jobseeker5@jt-demo.com": ["javascript", "typescript", "react", "nodejs", "sql", "git"],
};

function makeResumePdf(lines: string[]): Buffer {

const RECRUITERS = [
  {
    name: "Suphat Trakulsuk",
    email: "suphat.recruiter1@jt-demo.com",
    phone_number: "08123456001",
    bio: "Portfolio & Programme Manager at ALSTOM Thailand. 12+ years in digital transformation, project portfolio governance and continuous improvement.",
  },
  {
    name: "Nattapon Srisuk",
    email: "nattapon.recruiter2@jt-demo.com",
    phone_number: "08123456002",
    bio: "Senior Talent Acquisition Lead at Silicon Craft Technology. Semiconductor IC design hiring across layout, analog and mixed-signal roles.",
  },
  {
    name: "Chutima Wongsawat",
    email: "chutima.recruiter3@jt-demo.com",
    phone_number: "08123456003",
    bio: "Head of HR at Sri Trang Agro-Industry. Recruiting automation, digital manufacturing and industrial IT talent.",
  },
];

const COMPANIES = [
  {
    name: "ALSTOM (Thailand) Ltd.",
    description:
      "ALSTOM is a global leader in smart and sustainable mobility. We design, manufacture and service trains, signalling systems and digital mobility solutions. In Thailand, our Bangkok hub drives digitalisation, project portfolio management and continuous improvement programmes across the region.",
    website: "https://www.alstom.com",
    location: "Bangkok, Thailand",
    size: "10,000+ employees",
    industry: "Rail Transportation / Engineering",
    recruiterIndex: 0,
  },
  {
    name: "Silicon Craft Technology PLC",
    description:
      "Silicon Craft Technology is a Thai fabless semiconductor company specialising in analog and mixed-signal IC design, RFID and NFC solutions. We design high-reliability integrated circuits for automotive, IoT and identification applications and ship globally.",
    website: "https://www.siliconcraft.co.th",
    location: "Chatuchak, Bangkok, Thailand",
    size: "101-500 employees",
    industry: "Semiconductors / Electronics",
    recruiterIndex: 1,
  },
  {
    name: "Sri Trang Agro-Industry PCL",
    description:
      "Sri Trang Agro-Industry is one of the world's leading natural rubber producers. We are transforming our manufacturing plants through automation, digital manufacturing (MES/MOM), SCADA and industrial IoT to drive operational excellence across Thailand.",
    website: "https://www.sritrang.com",
    location: "Pathum Wan, Bangkok, Thailand",
    size: "10,000+ employees",
    industry: "Rubber / Manufacturing / Agribusiness",
    recruiterIndex: 2,
  },
];

const JOBS = [
  {
    title: "Portfolio Lead",
    description:
      "Manages the digital & continuous improvement project portfolio, governing project delivery, allocating resources, driving automation and solutions.",
    salary: "150000",
    location: "Bangkok, Thailand",
    job_type: "Full_time",
    openings: 2,
    role: "Programme / Project Management",
    work_location: "Hybrid",
    companyIndex: 0,
    details: {
      responsibilities:
        "Own the digital and continuous improvement project portfolio end-to-end. Govern project delivery across the region, enforcing stage gates, RAID logs and reporting. Allocate resources across competing programmes and resolve prioritisation conflicts. Drive automation and digital solutions that improve operational performance and support a global, inclusive and flexible working environment.",
      required_skills:
        "8+ years in portfolio, programme or project management in a global company. Strong governance, resource planning and stakeholder management. Experience delivering digital transformation and continuous improvement initiatives. Fluent business English.",
      preferred_skills:
        "PMP / PRINCE2 / MSP certification. Lean Six Sigma Green or Black Belt. Experience in rail, engineering or industrial sectors. International mobility mindset.",
      tech_stack: ["Jira", "Confluence", "MS Project", "Power BI", "Lean Six Sigma"],
      experience_years: 8,
      education: "Bachelor's degree in Engineering, Business or related field",
      certifications: ["PMP", "Lean Six Sigma Green Belt"],
      languages: ["English", "Thai"],
      benefits:
        "Global company with international mobility. Long-term career stability and challenging assignments. Inclusive and flexible working environment. Provident fund, health insurance, annual leave, hybrid work.",
      visa_sponsorship: true,
      working_hours: "Flexible, hybrid (2-3 days in office per week)",
      team_structure: "Digital & Continuous Improvement programme team; dotted-line into regional operations",
      reporting_line: "Head of Digital & Continuous Improvement, SEA",
      career_growth: "Portfolio Lead -> Programme Director -> Regional Operations / Digital Leadership",
      interview_process:
        "1. HR phone screen 2. Hiring manager interview 3. Technical / portfolio case study 4. Panel interview with regional stakeholders",
      application_instructions: "Apply online with your CV. ALSTOM is an equal opportunity employer.",
    },
  },
  {
    title: "Senior Software Engineer (Digital Solutions)",
    description:
      "Build digital solutions for rail mobility — real-time monitoring, predictive maintenance and data platforms. Part of the regional digital transformation portfolio.",
    salary: "120000",
    location: "Bangkok, Thailand",
    job_type: "Full_time",
    openings: 3,
    role: "Software Engineering",
    work_location: "Hybrid",
    companyIndex: 0,
    details: {
      responsibilities:
        "Design and build scalable backend services and APIs for rail digital solutions. Integrate IoT and telemetry streams into data platforms. Work in an agile squads delivering predictive maintenance and real-time monitoring features. Mentor junior engineers and own code quality end-to-end.",
      required_skills:
        "5+ years backend development with Node.js / TypeScript or Java. Strong SQL and API design. Experience with cloud platforms (AWS or Azure) and CI/CD.",
      preferred_skills:
        "Experience with IoT data pipelines, Kafka, Kubernetes, or time-series databases. Domain interest in transportation or industrial IoT.",
      tech_stack: ["Node.js", "TypeScript", "PostgreSQL", "Kafka", "Kubernetes", "AWS", "Docker"],
      experience_years: 5,
      education: "Bachelor's degree in Computer Science or related field",
      certifications: [],
      languages: ["English", "Thai"],
      benefits:
        "Hybrid work, provident fund, health insurance, international mobility opportunities, annual learning budget, flexible hours.",
      visa_sponsorship: true,
      working_hours: "Flexible, hybrid",
      team_structure: "Agile squad (8 engineers, 1 PO, 1 EM)",
      reporting_line: "Engineering Manager, Digital Solutions",
      career_growth: "Engineer -> Senior -> Tech Lead -> Engineering Manager",
      interview_process: "1. HR screen 2. Technical interview 3. Coding round 4. Team fit",
      application_instructions: "Apply with CV and GitHub or portfolio links.",
    },
  },
  {
    title: "IC Layout Engineer",
    description:
      "Design IC layout at block level and sub-system for analog and mixed-signal circuits used in RFID, NFC and automotive applications.",
    salary: "75000",
    location: "Chatuchak, Bangkok, Thailand",
    job_type: "Full_time",
    openings: 2,
    role: "IC Design / Layout",
    work_location: "Hybrid",
    companyIndex: 1,
    details: {
      responsibilities:
        "Perform analog and mixed-signal IC layout from block level to sub-system. Execute layout vs schematic (LVS) and design rule check (DRC). Collaborate with circuit design engineers to optimise parasitic performance. Deliver clean, on-time layout for tape-out milestones.",
      required_skills:
        "3+ years of IC layout experience using Cadence Virtuoso. Strong understanding of analog/mixed-signal layout techniques (matching, shielding, ESD). Proficiency with DRC/LVS flows.",
      preferred_skills:
        "Semiconductor industry background. Experience with RFID/NFC or power management ICs. Scripting in SKILL or Calibre familiarity.",
      tech_stack: ["Cadence Virtuoso", "Calibre", "Assura", "SKILL scripting"],
      experience_years: 3,
      education: "Bachelor's degree in Electrical / Electronics Engineering",
      certifications: [],
      languages: ["Thai", "English"],
      benefits:
        "Hybrid work, group life insurance, medical insurance, annual health check-up, company trip, annual leave, semiconductor industry exposure.",
      visa_sponsorship: false,
      working_hours: "Mon-Fri, hybrid",
      team_structure: "Analog design team (10 engineers, 1 team lead)",
      reporting_line: "IC Design Team Lead",
      career_growth: "Layout Engineer -> Senior Layout Engineer -> Team Lead",
      interview_process: "1. HR screen 2. Technical interview (layout fundamentals) 3. Take-home layout task 4. Team interview",
      application_instructions: "Apply with CV highlighting layout and DRC/LVS experience.",
    },
  },
  {
    title: "Analog / Mixed-Signal IC Design Engineer",
    description:
      "Design analog and mixed-signal integrated circuits for RFID, NFC and sensing applications. Full custom design from specification to tape-out.",
    salary: "95000",
    location: "Chatuchak, Bangkok, Thailand",
    job_type: "Full_time",
    openings: 1,
    role: "IC Design",
    work_location: "Hybrid",
    companyIndex: 1,
    details: {
      responsibilities:
        "Design analog and mixed-signal blocks including ADCs, DACs, bandgap references, regulators and RFID front-ends. Run schematic entry, simulation and verification. Support layout engineers and drive silicon bring-up. Document designs for production handoff.",
      required_skills:
        "5+ years analog/mixed-signal IC design. Strong transistor-level circuit theory. Proficiency with Cadence tools and simulation (Spectre). Experience taking designs to silicon.",
      preferred_skills:
        "RFID/NFC transponder or power management experience. Delta-sigma or SAR ADC expertise. PhD or strong research background a plus.",
      tech_stack: ["Cadence Virtuoso", "Spectre", "AMS", "SPICE"],
      experience_years: 5,
      education: "Master's degree preferred in Electrical / Electronics Engineering",
      certifications: [],
      languages: ["Thai", "English"],
      benefits:
        "Hybrid work, group life insurance, medical insurance, annual health check-up, company trip, semiconductor industry leadership role.",
      visa_sponsorship: false,
      working_hours: "Mon-Fri, hybrid",
      team_structure: "Analog design team (10 engineers, 1 team lead)",
      reporting_line: "IC Design Team Lead",
      career_growth: "Design Engineer -> Senior -> Principal -> Technical Fellow",
      interview_process: "1. HR screen 2. Circuit design technical interview 3. Simulation task 4. Panel interview",
      application_instructions: "Apply with CV and a summary of silicon-proven designs.",
    },
  },
  {
    title: "Digital Business Partner (Manufacturing)",
    description:
      "Act as the bridge between manufacturing and IT. Drive automation, MES/MOM, SCADA and industrial IoT adoption to transform rubber manufacturing plants.",
    salary: "90000",
    location: "Pathum Wan, Bangkok, Thailand",
    job_type: "Full_time",
    openings: 2,
    role: "Automation / Digital Manufacturing",
    work_location: "Hybrid",
    companyIndex: 2,
    details: {
      responsibilities:
        "Partner with plant operations to identify and prioritise automation and digitalisation opportunities. Lead MES/MOM and SCADA rollout programmes across sites. Drive OPC UA / Modbus data integration between equipment and IT systems. Track digital KPIs and champion continuous improvement culture.",
      required_skills:
        "5+ years as an Automation Engineer, Digital Business Partner or Project Manager in manufacturing. Knowledge of industrial protocols and interfaces: OPC UA, Modbus, Profibus/Profinet. Strong project and stakeholder management.",
      preferred_skills:
        "Exposure to MES/MOM, SCADA, PLC/HMI programming. IT/OT convergence experience. Lean manufacturing knowledge.",
      tech_stack: ["OPC UA", "Modbus", "MES/MOM", "SCADA", "PLC/HMI", "Ignition"],
      experience_years: 5,
      education: "Bachelor's degree in Engineering (Electrical / Mechanical / Industrial)",
      certifications: [],
      languages: ["Thai", "English"],
      benefits:
        "Provident fund, variable bonus, BTS Ploen Chit access, medical insurance, company car / allowance, career growth into industrial IT leadership.",
      visa_sponsorship: false,
      working_hours: "Mon-Fri, hybrid",
      team_structure: "Digital Manufacturing team; dotted-line into plant operations",
      reporting_line: "Head of Digital Manufacturing",
      career_growth: "Automation Engineer -> Digital Business Partner -> Plant / Digital Lead",
      interview_process: "1. HR screen 2. Technical interview (automation / protocols) 3. Stakeholder case study 4. Plant site visit",
      application_instructions: "Apply with CV highlighting automation projects and IT/OT experience.",
    },
  },
  {
    title: "Automation Engineer (OPC, Modbus)",
    description:
      "Design, deploy and support industrial automation systems including SCADA, PLC/HMI and data historians across rubber processing plants.",
    salary: "70000",
    location: "Pathum Wan, Bangkok, Thailand",
    job_type: "Full_time",
    openings: 3,
    role: "Automation Engineering",
    work_location: "On_site",
    companyIndex: 2,
    details: {
      responsibilities:
        "Configure and maintain SCADA systems and PLC/HMI applications. Integrate equipment and sensors via OPC UA and Modbus. Manage data historians and support IT/OT network architecture. Troubleshoot production automation issues and improve machine reliability.",
      required_skills:
        "3+ years in industrial automation. Hands-on PLC programming (Siemens / Allen-Bradley / Mitsubishi). SCADA configuration and OPC UA / Modbus integration. Willingness to work at plant sites.",
      preferred_skills:
        "HMI development, data historian (e.g., PI, Ignition), network segmentation (IT/OT), basic cybersecurity for ICS.",
      tech_stack: ["PLC", "HMI", "SCADA", "OPC UA", "Modbus", "Historian"],
      experience_years: 3,
      education: "Bachelor's degree in Electrical / Automation Engineering",
      certifications: ["SIEMENS TIA Portal"],
      languages: ["Thai", "English"],
      benefits:
        "Provident fund, variable bonus, medical insurance, plant site allowance, training budget for automation certifications.",
      visa_sponsorship: false,
      working_hours: "Mon-Fri, site-based with travel to plants",
      team_structure: "Central automation team (6 engineers, 1 lead)",
      reporting_line: "Automation Team Lead",
      career_growth: "Automation Engineer -> Senior -> Team Lead -> Plant Engineering Manager",
      interview_process: "1. HR screen 2. Technical interview (PLC / SCADA) 3. Site visit 4. Team interview",
      application_instructions: "Apply with CV and summary of deployed automation systems.",
    },
  },
  {
    title: "Signalling Systems Engineer",
    description:
      "Deliver train control and signalling systems (ERTMS, interlocking) for rail projects across the region, from design to commissioning.",
    salary: "110000",
    location: "Bangkok, Thailand",
    job_type: "Full_time",
    openings: 2,
    role: "Rail Signalling Engineering",
    work_location: "Hybrid",
    companyIndex: 0,
    details: {
      responsibilities:
        "Design and deliver signalling and train control systems (interlocking, ERTMS/ETCS, CBTC). Prepare design documents, interface definitions and test specifications. Support installation, testing and commissioning on site. Ensure compliance with local and international rail safety standards.",
      required_skills:
        "5+ years in railway signalling or train control engineering. Knowledge of interlocking principles, ERTMS/ETCS or CBTC. Experience with V&V, RAMS and safety assurance. Fluent English, willing to travel to project sites.",
      preferred_skills:
        "Hands-on with relay or computer-based interlocking. Experience with ERTMS Level 2 or CBTC. Site commissioning background.",
      tech_stack: ["ERTMS/ETCS", "CBTC", "Interlocking", "RAMS", "V&V", "AutoCAD"],
      experience_years: 5,
      education: "Bachelor's degree in Electrical / Electronic / Railway Engineering",
      certifications: ["IRSE membership"],
      languages: ["English", "Thai"],
      benefits:
        "Global mobility, provident fund, health insurance, project-based bonus, travel allowances, hybrid work.",
      visa_sponsorship: true,
      working_hours: "Flexible, hybrid + site visits",
      team_structure: "Signalling engineering team (12 engineers, 2 leads)",
      reporting_line: "Signalling Engineering Manager",
      career_growth: "Engineer -> Senior -> Lead -> Signalling Systems Architect",
      interview_process: "1. HR screen 2. Technical interview (signalling principles) 3. Case study 4. Panel interview",
      application_instructions: "Apply online with CV. Include rail systems experience in detail.",
    },
  },
  {
    title: "Project Manager (Rail Projects)",
    description:
      "Lead and deliver railway engineering projects from initiation through closeout — scope, schedule, budget, quality and stakeholder management.",
    salary: "130000",
    location: "Bangkok, Thailand",
    job_type: "Full_time",
    openings: 1,
    role: "Project Management",
    work_location: "Hybrid",
    companyIndex: 0,
    details: {
      responsibilities:
        "Lead and deliver rail engineering projects from initiation through closeout. Own scope, schedule, budget and quality across multidisciplinary teams. Manage risk, procurement and subcontractors. Report to regional programme leadership and keep stakeholders aligned.",
      required_skills:
        "7+ years leading engineering projects, ideally in rail, infrastructure or heavy industry. Strong PM fundamentals (WBS, critical path, earned value). Excellent stakeholder communication in English.",
      preferred_skills:
        "PMP / PRINCE2 certification. Engineering background (CE/EE/ME). Experience with large-scale infrastructure contracts.",
      tech_stack: ["MS Project", "Primavera P6", "Jira", "Power BI", "Excel"],
      experience_years: 7,
      education: "Bachelor's degree in Engineering (CE/EE/ME)",
      certifications: ["PMP"],
      languages: ["English", "Thai"],
      benefits:
        "Long-term project stability, international mobility, provident fund, health insurance, performance bonus, hybrid work.",
      visa_sponsorship: true,
      working_hours: "Mon-Fri, hybrid",
      team_structure: "Project team (engineers, QA/QC, site team, procurement)",
      reporting_line: "Programme Director",
      career_growth: "PM -> Senior PM -> Programme Manager -> Programme Director",
      interview_process: "1. HR screen 2. PM case study 3. Stakeholder interview 4. Panel with regional leadership",
      application_instructions: "Apply with CV and project portfolio summary.",
    },
  },
  {
    title: "Digital Transformation Analyst",
    description:
      "Support the digital & continuous improvement portfolio — data analysis, process automation and reporting for regional mobility programmes.",
    salary: "60000",
    location: "Bangkok, Thailand",
    job_type: "Full_time",
    openings: 2,
    role: "Business Analysis / Digital",
    work_location: "Hybrid",
    companyIndex: 0,
    details: {
      responsibilities:
        "Analyse business processes and data to identify improvement opportunities. Build dashboards and automate reporting with Power BI. Support portfolio governance and project tracking. Coordinate with operations teams on digital initiatives and continuous improvement.",
      required_skills:
        "3+ years in business analysis, data analysis or process improvement. Strong Excel/SQL and Power BI or Tableau. Lean Six Sigma or process mapping experience. Good communication in English.",
      preferred_skills:
        "Experience with RPA (UiPath, Power Automate). Knowledge of continuous improvement methodologies. Engineering or operations background.",
      tech_stack: ["Power BI", "SQL", "Excel", "Power Automate", "Jira", "Lean"],
      experience_years: 3,
      education: "Bachelor's degree in Business, Engineering or related field",
      certifications: ["Lean Six Sigma Yellow Belt"],
      languages: ["English", "Thai"],
      benefits:
        "Career growth in a global company, hybrid work, provident fund, health insurance, learning budget.",
      visa_sponsorship: false,
      working_hours: "Flexible, hybrid",
      team_structure: "Digital & Continuous Improvement team",
      reporting_line: "Head of Digital & Continuous Improvement, SEA",
      career_growth: "Analyst -> Senior Analyst -> Portfolio Lead -> Programme Manager",
      interview_process: "1. HR screen 2. Analytical case study 3. Technical interview (Power BI / SQL) 4. Team fit",
      application_instructions: "Apply with CV and example dashboards or analysis work.",
    },
  },
  {
    title: "RFID / NFC System Engineer",
    description:
      "Design and support RFID and NFC solutions end-to-end — tags, readers and system integration for identification and IoT applications.",
    salary: "80000",
    location: "Chatuchak, Bangkok, Thailand",
    job_type: "Full_time",
    openings: 2,
    role: "RF / System Engineering",
    work_location: "Hybrid",
    companyIndex: 1,
    details: {
      responsibilities:
        "Design RFID/NFC system architectures from tag and reader selection to integration. Develop application layers and demo solutions for customers. Perform RF measurements and field testing. Support customer deployments and technical sales.",
      required_skills:
        "4+ years in RFID/NFC, RF engineering or IoT systems. Understanding of RF principles, antennas and standards (ISO 14443, ISO 15693, EPC Gen2). Experience integrating readers and tags.",
      preferred_skills:
        "Embedded programming (C/C++, Python). Experience with HF/UHF reader products. RF test equipment (network analyser, spectrum analyser).",
      tech_stack: ["RFID", "NFC", "ISO 14443", "EPC Gen2", "Python", "C/C++", "HF/UHF"],
      experience_years: 4,
      education: "Bachelor's degree in Electrical / Electronics / Telecommunications Engineering",
      certifications: [],
      languages: ["Thai", "English"],
      benefits:
        "Hybrid work, group life insurance, medical insurance, annual health check-up, company trip, technical training.",
      visa_sponsorship: false,
      working_hours: "Mon-Fri, hybrid",
      team_structure: "RFID solutions team (6 engineers, 1 lead)",
      reporting_line: "Solutions Engineering Lead",
      career_growth: "System Engineer -> Senior -> Solutions Architect -> Engineering Manager",
      interview_process: "1. HR screen 2. Technical interview (RF / RFID) 3. Hands-on demo task 4. Team interview",
      application_instructions: "Apply with CV and RFID/RF project examples.",
    },
  },
  {
    title: "IC Test Engineer",
    description:
      "Develop and execute test programs for analog and mixed-signal ICs using ATE, from package-level characterisation to production test.",
    salary: "85000",
    location: "Chatuchak, Bangkok, Thailand",
    job_type: "Full_time",
    openings: 2,
    role: "IC Test Engineering",
    work_location: "On_site",
    companyIndex: 1,
    details: {
      responsibilities:
        "Develop and debug test programs for analog/mixed-signal ICs on ATE (Advantest, Teradyne, or in-house testers). Design test boards and fixtures. Perform characterization and production test bring-up. Analyse yield data and drive test time reduction.",
      required_skills:
        "4+ years in semiconductor test engineering. Programming in C, Python or V93K/SMT test languages. Understanding of analog/mixed-signal measurements and ATE. Knowledge of DFT and yield analysis.",
      preferred_skills:
        "Experience with RFID/NFC or power management ICs. Test board design (schematic/layout). Statistical data analysis.",
      tech_stack: ["ATE", "Python", "C", "SMT8", "V93K", "Yield analysis"],
      experience_years: 4,
      education: "Bachelor's degree in Electrical / Electronics Engineering",
      certifications: [],
      languages: ["Thai", "English"],
      benefits:
        "Group life insurance, medical insurance, annual health check-up, company trip, semiconductor industry growth.",
      visa_sponsorship: false,
      working_hours: "Mon-Fri, on-site (test lab)",
      team_structure: "Test engineering team (5 engineers, 1 lead)",
      reporting_line: "Test Engineering Manager",
      career_growth: "Test Engineer -> Senior -> Lead -> Test Engineering Manager",
      interview_process: "1. HR screen 2. Technical interview (ATE / test programming) 3. Coding task 4. Team interview",
      application_instructions: "Apply with CV highlighting ATE and test program experience.",
    },
  },
  {
    title: "Embedded Firmware Engineer",
    description:
      "Develop firmware for RFID and NFC tags and reader modules — real-time control, protocol stacks and power-optimised embedded code.",
    salary: "70000",
    location: "Chatuchak, Bangkok, Thailand",
    job_type: "Full_time",
    openings: 2,
    role: "Embedded Software",
    work_location: "Hybrid",
    companyIndex: 1,
    details: {
      responsibilities:
        "Develop embedded firmware for RFID/NFC tags and readers in C/C++. Implement protocol stacks and RF control algorithms. Optimise power consumption and performance. Debug on hardware with logic analysers and debuggers, and support production bring-up.",
      required_skills:
        "3+ years embedded firmware development in C/C++. Experience with MCU (ARM Cortex-M), RTOS, and low-level peripherals (SPI, I2C, UART). Debugging with JTAG/SWD, oscilloscopes and logic analysers.",
      preferred_skills:
        "RFID/NFC protocol experience (ISO 14443, ISO 15693). Wireless connectivity (BLE). Python for test scripting.",
      tech_stack: ["C", "C++", "ARM Cortex-M", "RTOS", "BLE", "SPI", "I2C"],
      experience_years: 3,
      education: "Bachelor's degree in Computer / Electrical Engineering",
      certifications: [],
      languages: ["Thai", "English"],
      benefits:
        "Hybrid work, group life insurance, medical insurance, annual health check-up, company trip, training budget.",
      visa_sponsorship: false,
      working_hours: "Mon-Fri, hybrid",
      team_structure: "Firmware team (4 engineers, 1 lead)",
      reporting_line: "Firmware Engineering Lead",
      career_growth: "Firmware Engineer -> Senior -> Tech Lead -> Engineering Manager",
      interview_process: "1. HR screen 2. Embedded coding interview 3. Take-home firmware task 4. Team interview",
      application_instructions: "Apply with CV and GitHub or firmware project examples.",
    },
  },
  {
    title: "Data Engineer (Industrial IoT)",
    description:
      "Build data pipelines for industrial IoT — collecting, processing and analysing machine and sensor data from rubber plants.",
    salary: "85000",
    location: "Pathum Wan, Bangkok, Thailand",
    job_type: "Full_time",
    openings: 2,
    role: "Data Engineering",
    work_location: "Hybrid",
    companyIndex: 2,
    details: {
      responsibilities:
        "Design and build data pipelines ingesting industrial IoT and sensor data. Develop ETL/ELT processes and time-series storage. Build dashboards for plant operations and digital KPIs. Ensure data quality, lineage and governance across manufacturing sites.",
      required_skills:
        "4+ years in data engineering. Strong SQL and Python (pandas, Airflow). Experience with time-series databases and streaming (Kafka, MQTT). Cloud data platforms (AWS/GCP/Azure).",
      preferred_skills:
        "Industrial IoT / SCADA data exposure. dbt, Spark or Databricks. Knowledge of OPC UA / MQTT data sources.",
      tech_stack: ["Python", "SQL", "Kafka", "MQTT", "Airflow", "TimescaleDB", "AWS"],
      experience_years: 4,
      education: "Bachelor's degree in Computer Science, Data Science or related field",
      certifications: [],
      languages: ["Thai", "English"],
      benefits:
        "Provident fund, variable bonus, medical insurance, BTS access, professional development budget, hybrid work.",
      visa_sponsorship: false,
      working_hours: "Mon-Fri, hybrid",
      team_structure: "Data & digital team (6 engineers, 1 lead)",
      reporting_line: "Head of Digital Manufacturing",
      career_growth: "Data Engineer -> Senior -> Lead -> Head of Data",
      interview_process: "1. HR screen 2. SQL/Python technical 3. Pipeline design case study 4. Team interview",
      application_instructions: "Apply with CV and example data pipeline projects.",
    },
  },
  {
    title: "Plant Operations Excellence Specialist",
    description:
      "Drive operational excellence by analysing data, optimising processes, improving performance and enhancing customer experience at rubber plants.",
    salary: "65000",
    location: "Pathum Wan, Bangkok, Thailand",
    job_type: "Full_time",
    openings: 2,
    role: "Operations Excellence",
    work_location: "On_site",
    companyIndex: 2,
    details: {
      responsibilities:
        "Analyse plant operations data to identify performance gaps and improvement opportunities. Lead continuous improvement (Lean, Kaizen, Six Sigma) projects. Optimise processes to reduce cost and waste. Enhance customer experience through on-time, quality delivery. Track and report operations KPIs.",
      required_skills:
        "4+ years in operations, process improvement or production management in manufacturing. Strong analytical skills (Excel, SQL). Experience running Lean / Six Sigma projects. Willingness to work at plant sites across Thailand.",
      preferred_skills:
        "Six Sigma Green/Black Belt. Experience in rubber, agro or process industry. Exposure to MES/MOM and OEE tracking.",
      tech_stack: ["Excel", "SQL", "Power BI", "Lean Six Sigma", "MES/MOM"],
      experience_years: 4,
      education: "Bachelor's degree in Industrial / Mechanical / Chemical Engineering",
      certifications: ["Lean Six Sigma Green Belt"],
      languages: ["Thai", "English"],
      benefits:
        "Provident fund, variable bonus, medical insurance, plant site allowance, clear path to plant leadership.",
      visa_sponsorship: false,
      working_hours: "Mon-Fri, site-based",
      team_structure: "Operations excellence team; embedded in plants",
      reporting_line: "Plant Manager / Head of Operations Excellence",
      career_growth: "Specialist -> Senior -> Plant Operations Manager -> Plant Manager",
      interview_process: "1. HR screen 2. Case study (process improvement) 3. Plant visit 4. Leadership interview",
      application_instructions: "Apply with CV and improvement project examples.",
    },
  },
  {
    title: "Cybersecurity Engineer (IT/OT)",
    description:
      "Protect manufacturing networks — secure IT/OT convergence, industrial control systems and data platforms across plants.",
    salary: "90000",
    location: "Pathum Wan, Bangkok, Thailand",
    job_type: "Full_time",
    openings: 1,
    role: "Cybersecurity",
    work_location: "Hybrid",
    companyIndex: 2,
    details: {
      responsibilities:
        "Design and enforce security controls for IT/OT convergence across manufacturing sites. Segment industrial networks and secure PLCs/SCADA. Manage vulnerabilities, monitoring and incident response for OT environments. Drive security awareness and compliance with standards.",
      required_skills:
        "5+ years in cybersecurity, with hands-on OT/ICS security. Network security and segmentation (firewalls, VLANs, DMZ). Familiarity with ICS protocols and Purdue model. Incident response experience.",
      preferred_skills:
        "Certifications: CISSP, GICSP, or IEC 62443. Experience with industrial IDS/OT monitoring tools. Threat hunting.",
      tech_stack: ["IEC 62443", "Purdue model", "Firewalls", "IDS/IPS", "SIEM", "OT monitoring"],
      experience_years: 5,
      education: "Bachelor's degree in Computer Science, IT or related field",
      certifications: ["GICSP"],
      languages: ["Thai", "English"],
      benefits:
        "Provident fund, variable bonus, medical insurance, BTS access, certification budget, hybrid work.",
      visa_sponsorship: false,
      working_hours: "Mon-Fri, hybrid",
      team_structure: "IT/OT security team (3 engineers, 1 lead)",
      reporting_line: "Head of IT Security",
      career_growth: "Security Engineer -> Senior -> OT Security Lead -> CISO track",
      interview_process: "1. HR screen 2. Technical interview (OT security) 3. Incident response scenario 4. Team interview",
      application_instructions: "Apply with CV and OT/ICS security project experience.",
    },
  },
];

const JOBSEEKER_SKILLS: Record<string, string[]> = {
  "wichit.jobseeker1@jt-demo.com": ["javascript", "typescript", "nodejs", "postgresql", "docker", "kubernetes", "kafka", "aws"],
  "pimchanok.jobseeker2@jt-demo.com": ["circuit design", "ic layout", "cadence virtuoso", "analog design", "mixed-signal"],
  "krit.jobseeker3@jt-demo.com": ["plc", "scada", "opc ua", "modbus", "python"],
  "anongrat.jobseeker4@jt-demo.com": ["project management", "jira", "microsoft project", "lean six sigma", "sql"],
  "sarawut.jobseeker5@jt-demo.com": ["javascript", "typescript", "react", "nodejs", "sql", "git"],
};

function makeResumePdf(lines: string[]): Buffer {
  let content = "BT\n/F1 12 Tf\n72 740 Td\n";
  lines.forEach((line, i) => {
    content += `0 -16 Td\n(${line.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)")}) Tj\n`;
  });
  content += "ET";

  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<</Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [0];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(pdf, "ascii"));
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(pdf, "ascii");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, "ascii");
}

async function main() {
  console.log("Seeding clean demo database...");

  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE users, companies, jobs, skills, user_skills, applications, job_analytics, notifications, outbox_events, consumer_dedup, event_outbox RESTART IDENTITY CASCADE`,
  );
  console.log("[1/7] All existing data wiped (users, companies, jobs, skills, applications, analytics, outbox, events)");

  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 12);

  // 2) Recruiters
  const recruiters = [];
  for (const r of RECRUITERS) {
    const user = await prisma.user.create({
      data: {
        name: r.name,
        email: r.email,
        password: passwordHash,
        phone_number: r.phone_number,
        role: "recruiter",
        bio: r.bio,
        is_verified: true,
      },
    });
    recruiters.push(user);
  }
  console.log(`[2/7] Created ${recruiters.length} verified recruiters`);

  // 3) Companies
  const companies = [];
  for (const c of COMPANIES) {
    const company = await prisma.company.create({
      data: {
        name: c.name,
        description: c.description,
        website: c.website,
        location: c.location,
        size: c.size,
        industry: c.industry,
        recruiter_id: recruiters[c.recruiterIndex].user_id,
      },
    });
    companies.push(company);
  }
  console.log(`[3/7] Created ${companies.length} companies`);

  // 4) Jobs
  const jobs = [];
  for (const j of JOBS) {
    const job = await prisma.job.create({
      data: {
        title: j.title,
        description: j.description,
        salary: j.salary,
        location: j.location,
        job_type: j.job_type as any,
        openings: j.openings,
        role: j.role,
        work_location: j.work_location as any,
        company_id: companies[j.companyIndex].company_id,
        posted_by_recruiter_id: companies[j.companyIndex].recruiter_id,
        details: j.details,
        is_active: true,
      },
    });
    jobs.push(job);
  }
  console.log(`[4/7] Created ${jobs.length} active jobs`);

  // 5) Skills
  for (const name of SKILLS) {
    await prisma.skill.upsert({
      where: { name },
      create: { name },
      update: {},
    });
  }
  console.log(`[5/7] Created ${SKILLS.length} skills`);

  // 6) Jobseekers with real PDF resumes on Cloudinary
  const jobseekers = [];
  for (const js of JOBSEEKERS) {
    // Generate a real resume PDF with professional content
    const pdfLines = [
      "PROFILE",
      `${js.name}: ${js.bio || "Senior professional with experience in the relevant field."}`,
      "SKILLS",
      (JOBSEEKER_SKILLS[js.email] ?? []).join(", "),
      "EXPERIENCE",
      "Demonstrated experience in the relevant field with a proven track record of delivering results in cross-functional, fast-paced environments.",
      "EDUCATION",
      "Bachelor's degree in the relevant field",
    ];
    const pdfBuffer = makeResumePdf(pdfLines);

    // Upload to Cloudinary
    const uploadResult = await cloudinary.uploader.upload(
      pdfBuffer,
      {
        folder: "j-track/resumes",
        resource_type: "raw",
        public_id: `resume_${js.email.split("@")[0]}`,
      }
    );

    const user = await prisma.user.create({
      data: {
        name: js.name,
        email: js.email,
        password: passwordHash,
        phone_number: js.phone_number,
        role: "jobseeker",
        bio: js.bio,
        is_verified: true,
        resume: uploadResult.secure_url,
        resume_public_id: uploadResult.public_id,
      },
    });
    jobseekers.push(user);

    for (const skillName of JOBSEEKER_SKILLS[js.email] ?? []) {
      const skill = await prisma.skill.findUnique({ where: { name: skillName } });
      if (skill) {
        await prisma.userSkill.upsert({
          where: {
            user_id_skill_id: { user_id: user.user_id, skill_id: skill.skill_id },
          },
          create: { user_id: user.user_id, skill_id: skill.skill_id },
          update: {},
        });
      }
    }
  }
  console.log(`[6/7] Created ${jobseekers.length} verified jobseekers with PDF resumes + skills`);

  // 7) Summary
  console.log("[7/7] Seed complete");
  console.log("");
  console.log("==============================================================");
  console.log("TEST CREDENTIALS (password for ALL accounts): " + TEST_PASSWORD);
  console.log("==============================================================");
  console.log("");
  console.log("RECRUITERS (verified)");
  for (const r of recruiters) {
    console.log(`  ${r.email.padEnd(34)} ${r.name}`);
  }
  console.log("");
  console.log("JOBSEEKERS (verified)");
  for (const j of jobseekers) {
    console.log(`  ${j.email.padEnd(34)} ${j.name} (resume: ${j.resume?.substring(0, 60)}...)`);
  }
  console.log("");
  console.log("COMPANIES -> jobs");
  for (const c of companies) {
    const companyJobs = jobs.filter((j) => j.company_id === c.company_id);
    console.log(`  ${c.name}`);
    for (const j of companyJobs) {
      console.log(`    - ${j.title}  [${j.job_type} / ${j.work_location}]  salary ${j.salary}`);
    }
  }
}

main()
  .catch((e) => {
    console.error("Seed failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
