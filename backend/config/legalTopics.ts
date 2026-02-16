export interface LegalSourceDefinition {
    id: string;
    title: string;
    url: string;
    authority: string;
    note?: string;
}

export interface LegalTopicDefinition {
    id: string;
    name: string;
    region: string;
    legalArea: string;
    description: string;
    focusChecks: string[];
    sources: LegalSourceDefinition[];
}

const LEGAL_TOPIC_ALIASES: Record<string, string> = {
    'eu-dma-platform-fairness': 'eu-dma-fairness',
    'eu-dsa-platform-safety': 'eu-dsa-platform-compliance',
    'eu-ai-act': 'eu-ai-act-transparency',
    'eu-accessibility': 'eu-accessibility-eaa'
};

export const LEGAL_TOPICS: LegalTopicDefinition[] = [
    {
        id: 'eu-gdpr-privacy',
        name: 'EU GDPR & Web Privacy',
        region: 'EU',
        legalArea: 'Data Protection',
        description: 'Checks website privacy and personal data handling obligations for public-facing digital services.',
        focusChecks: [
            'Transparent privacy notice and legal basis communication',
            'Data subject rights and contact pathways',
            'Cookie and tracking transparency',
            'Consent clarity and revocation paths',
            'Security and minimisation signals in user flows'
        ],
        sources: [
            {
                id: 'gdpr',
                title: 'General Data Protection Regulation (EU) 2016/679',
                url: 'https://eur-lex.europa.eu/eli/reg/2016/679/oj',
                authority: 'EUR-Lex'
            },
            {
                id: 'eprivacy',
                title: 'ePrivacy Directive 2002/58/EC',
                url: 'https://eur-lex.europa.eu/eli/dir/2002/58/oj',
                authority: 'EUR-Lex'
            }
        ]
    },
    {
        id: 'eu-ai-act-transparency',
        name: 'EU AI Act Transparency',
        region: 'EU',
        legalArea: 'AI Regulation',
        description: 'Checks transparency and user-facing obligations when AI features are exposed in digital interfaces.',
        focusChecks: [
            'Clear user awareness when interacting with AI systems',
            'Disclosure language and traceability hints',
            'Risk and safety communication in product flows',
            'Human oversight and fallback options in critical decisions'
        ],
        sources: [
            {
                id: 'ai-act',
                title: 'AI Act Regulation (EU) 2024/1689',
                url: 'https://eur-lex.europa.eu/eli/reg/2024/1689/oj',
                authority: 'EUR-Lex'
            }
        ]
    },
    {
        id: 'eu-dsa-platform-compliance',
        name: 'EU Digital Services Act (DSA)',
        region: 'EU',
        legalArea: 'Platform Governance',
        description: 'Checks platform transparency, notices, recommender disclosures, and user protection mechanisms.',
        focusChecks: [
            'Terms and transparency disclosures for digital services',
            'Notice and action information pathways',
            'Recommender and ranking transparency where applicable',
            'User redress and complaint channels'
        ],
        sources: [
            {
                id: 'dsa',
                title: 'Digital Services Act Regulation (EU) 2022/2065',
                url: 'https://eur-lex.europa.eu/eli/reg/2022/2065/oj',
                authority: 'EUR-Lex'
            }
        ]
    },
    {
        id: 'eu-dma-fairness',
        name: 'EU Digital Markets Act (DMA)',
        region: 'EU',
        legalArea: 'Competition & Platform Fairness',
        description: 'Checks fair defaults, user choice surfaces, and anti-steering risk indicators in platform UX.',
        focusChecks: [
            'Default choice architecture and user switching ability',
            'Fair access and non-steering indicators',
            'Interoperability or equivalent user-choice pathways',
            'Business-user and end-user fairness signals'
        ],
        sources: [
            {
                id: 'dma',
                title: 'Digital Markets Act Regulation (EU) 2022/1925',
                url: 'https://eur-lex.europa.eu/eli/reg/2022/1925/oj',
                authority: 'EUR-Lex'
            }
        ]
    },
    {
        id: 'eu-accessibility-eaa',
        name: 'EU Accessibility (EAA)',
        region: 'EU',
        legalArea: 'Accessibility',
        description: 'Checks accessibility-related legal expectations for digital products and service interfaces.',
        focusChecks: [
            'Accessible navigation and understandable labels',
            'Keyboard access and focus management expectations',
            'Readable structure and meaningful UI control naming',
            'Support information for accessibility barriers'
        ],
        sources: [
            {
                id: 'eaa',
                title: 'European Accessibility Act Directive (EU) 2019/882',
                url: 'https://eur-lex.europa.eu/eli/dir/2019/882/oj',
                authority: 'EUR-Lex'
            }
        ]
    }
];

export const getLegalTopicDefinition = (topicId: string): LegalTopicDefinition | undefined => {
    const normalized = String(topicId || '').trim().toLowerCase();
    const canonicalId = LEGAL_TOPIC_ALIASES[normalized] || normalized;
    return LEGAL_TOPICS.find((topic) => topic.id === canonicalId);
};
