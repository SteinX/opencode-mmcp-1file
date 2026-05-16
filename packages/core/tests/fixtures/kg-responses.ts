export type MCPTextBlock = {
  type: "text"
  text: string
}

export type MCPToolResult = {
  content: MCPTextBlock[]
}

export type KnowledgeGraphEntity = {
  id: string
  name: string
  entity_type?: string
  description?: string
}

export type KnowledgeGraphRelation = {
  from: string
  to: string
  relation_type: string
  weight?: number
}

export type DetectCommunitiesPayload = {
  communities: Array<{
    id: string
    label: string
    size: number
    score?: number
    entities: KnowledgeGraphEntity[]
    relations: KnowledgeGraphRelation[]
  }>
}

export type GetRelatedPayload = {
  entity: KnowledgeGraphEntity
  depth: number
  direction: "in" | "out" | "both"
  related: Array<{
    entity: KnowledgeGraphEntity
    distance: number
    path: string[]
    relation?: KnowledgeGraphRelation
  }>
}

export const detectCommunitiesPopulatedResponse: MCPToolResult = {
  content: [
    {
      type: "text",
      text: JSON.stringify({
        communities: [
          {
            id: "community-auth",
            label: "Auth + Session",
            size: 3,
            score: 0.92,
            entities: [
              { id: "svc-auth", name: "Auth Service", entity_type: "service" },
              { id: "svc-session", name: "Session Service", entity_type: "service" },
              { id: "mod-login", name: "Login Flow", entity_type: "module" },
            ],
            relations: [
              { from: "svc-auth", to: "svc-session", relation_type: "depends_on", weight: 0.9 },
              { from: "mod-login", to: "svc-auth", relation_type: "uses", weight: 0.8 },
            ],
          },
        ],
      }),
    },
  ],
}

export const detectCommunitiesEmptyResponse: MCPToolResult = {
  content: [
    {
      type: "text",
      text: JSON.stringify({ communities: [] }),
    },
  ],
}

export const getRelatedPopulatedResponse: MCPToolResult = {
  content: [
    {
      type: "text",
      text: JSON.stringify({
        entity: { id: "svc-auth", name: "Auth Service", entity_type: "service" },
        depth: 1,
        direction: "both",
        related: [
          {
            entity: { id: "svc-session", name: "Session Service", entity_type: "service" },
            distance: 1,
            path: ["svc-auth", "svc-session"],
            relation: { from: "svc-auth", to: "svc-session", relation_type: "depends_on", weight: 0.9 },
          },
          {
            entity: { id: "mod-login", name: "Login Flow", entity_type: "module" },
            distance: 1,
            path: ["mod-login", "svc-auth"],
            relation: { from: "mod-login", to: "svc-auth", relation_type: "uses", weight: 0.8 },
          },
        ],
      }),
    },
  ],
}

export const getRelatedEmptyResponse: MCPToolResult = {
  content: [
    {
      type: "text",
      text: JSON.stringify({
        entity: { id: "svc-auth", name: "Auth Service", entity_type: "service" },
        depth: 1,
        direction: "both",
        related: [],
      }),
    },
  ],
}

export const getRelatedNotFoundResponse: MCPToolResult = {
  content: [
    {
      type: "text",
      text: JSON.stringify({
        error: "entity_not_found",
        message: "No entity found for id: missing-entity",
        entity_id: "missing-entity",
      }),
    },
  ],
}

export const malformedKnowledgeGraphResponse: MCPToolResult = {
  content: [
    {
      type: "text",
      text: "{communities:[broken",
    },
    {
      type: "image" as never,
      data: "ignored" as never,
    } as MCPTextBlock,
  ],
}
