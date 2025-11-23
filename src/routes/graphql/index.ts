import { FastifyPluginAsync } from 'fastify';
import { createGqlResponseSchema, gqlResponseSchema } from './schemas.js';
import { graphql, buildSchema, GraphQLSchema, GraphQLObjectType, parse, validate, GraphQLFieldResolver, GraphQLResolveInfo, ExecutionResult } from 'graphql';
import depthLimit from 'graphql-depth-limit';
import DataLoader from 'dataloader';
import type { Prisma, PrismaClient, User, Post, Profile, MemberType } from '@prisma/client';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = join(fileURLToPath(import.meta.url), '..');

const plugin: FastifyPluginAsync = async (fastify) => {
  

  // Load schema from file
  const typeDefs = readFileSync(join(__dirname, '../../../schema.graphql'), 'utf8');
  let schema: GraphQLSchema;

  try {
    schema = buildSchema(typeDefs);
  } catch (error) {
    throw new Error(`Failed to build GraphQL schema: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Type definitions for args and context
  interface GqlLoaders {
    user: DataLoader<string, User | null>;
    posts: DataLoader<string, Post[]>;
    memberType: DataLoader<string, MemberType | null>;
    subscribers: DataLoader<string, User[]>; // authors for a subscriber
    subscribedTo: DataLoader<string, User[]>; // subscribers for an author
    profile: DataLoader<string, Profile | null>;
  }

  interface GqlContext {
    prisma: PrismaClient;
    loaders?: GqlLoaders;
  }

  interface IdArg { id: string }
  interface DtoArg<T> { dto: T }
  interface SubscribeArg { userId: string; authorId: string }

  // Root resolvers (mutations and queries) - defined early for attachment to schema
  const rootValue = {
    // Queries
    memberTypes: async (_parent: unknown, _args: unknown, context: GqlContext) =>
      context.prisma.memberType.findMany(),
    memberType: async (_parent: unknown, args: IdArg, context: GqlContext) =>
      context.prisma.memberType.findUnique({ where: { id: args.id } }),
    users: async (_parent: unknown, _args: unknown, context: GqlContext) =>
      context.prisma.user.findMany(),
    user: async (_parent: unknown, args: IdArg, context: GqlContext) =>
      context.prisma.user.findUnique({ where: { id: args.id } }),
    posts: async (_parent: unknown, _args: unknown, context: GqlContext) =>
      context.prisma.post.findMany(),
    post: async (_parent: unknown, args: IdArg, context: GqlContext) =>
      context.prisma.post.findUnique({ where: { id: args.id } }),
    profiles: async (_parent: unknown, _args: unknown, context: GqlContext) =>
      context.prisma.profile.findMany(),
    profile: async (_parent: unknown, args: IdArg, context: GqlContext) =>
      context.prisma.profile.findUnique({ where: { id: args.id } }),

    // Mutations
    createUser: async (_parent: unknown, args: DtoArg<{ name: string; balance: number }>, context: GqlContext) =>
      context.prisma.user.create({ data: args.dto }),
    createProfile: async (_parent: unknown, args: DtoArg<{ isMale: boolean; yearOfBirth: number; userId: string; memberTypeId: string }>, context: GqlContext) =>
      context.prisma.profile.create({ data: args.dto }),
    createPost: async (_parent: unknown, args: DtoArg<{ title: string; content: string; authorId: string }>, context: GqlContext) =>
      context.prisma.post.create({ data: args.dto }),
    changePost: async (_parent: unknown, args: { id: string; dto: { title?: string; content?: string } }, context: GqlContext) =>
      context.prisma.post.update({ where: { id: args.id }, data: args.dto }),
    changeProfile: async (_parent: unknown, args: { id: string; dto: { isMale?: boolean; yearOfBirth?: number; memberTypeId?: string } }, context: GqlContext) =>
      context.prisma.profile.update({ where: { id: args.id }, data: args.dto }),
    changeUser: async (_parent: unknown, args: { id: string; dto: { name?: string; balance?: number } }, context: GqlContext) =>
      context.prisma.user.update({ where: { id: args.id }, data: args.dto }),
    deleteUser: async (_parent: unknown, args: IdArg, context: GqlContext) => {
      await context.prisma.user.delete({ where: { id: args.id } });
      return 'OK';
    },
    deletePost: async (_parent: unknown, args: IdArg, context: GqlContext) => {
      await context.prisma.post.delete({ where: { id: args.id } });
      return 'OK';
    },
    deleteProfile: async (_parent: unknown, args: IdArg, context: GqlContext) => {
      await context.prisma.profile.delete({ where: { id: args.id } });
      return 'OK';
    },
    subscribeTo: async (_parent: unknown, args: SubscribeArg, context: GqlContext) => {
      await context.prisma.subscribersOnAuthors.create({
        data: { subscriberId: args.userId, authorId: args.authorId },
      });
      return 'OK';
    },
    unsubscribeFrom: async (_parent: unknown, args: SubscribeArg, context: GqlContext) => {
      await context.prisma.subscribersOnAuthors.delete({
        where: { subscriberId_authorId: { subscriberId: args.userId, authorId: args.authorId } },
      });
      return 'OK';
    },
  };

  // Attach field resolvers to the schema
  const rootQueryType = schema.getType('RootQueryType') as GraphQLObjectType | undefined;
  const mutationsType = schema.getType('Mutations') as GraphQLObjectType | undefined;
  const userType = schema.getType('User') as GraphQLObjectType | undefined;
  const profileType = schema.getType('Profile') as GraphQLObjectType | undefined;

  if (userType) {
    const userFields = userType.getFields();
    const postsField = userFields.posts;
    const userSubscribedToField = userFields.userSubscribedTo;
    const subscribedToUserField = userFields.subscribedToUser;
    const profileField = userFields.profile;

    if (postsField) {
      postsField.resolve = (parent: { id: string }, _args: unknown, context: GqlContext) =>
        context.loaders?.posts ? context.loaders.posts.load(parent.id) : context.prisma.post.findMany({ where: { authorId: parent.id } });
    }

    if (profileField) {
      profileField.resolve = (parent: { id: string }, _args: unknown, context: GqlContext) =>
        context.loaders?.profile ? context.loaders.profile.load(parent.id) : context.prisma.profile.findUnique({ where: { userId: parent.id } });
    }

    if (userSubscribedToField) {
      userSubscribedToField.resolve = async (parent: { id: string; userSubscribedTo?: Array<{ author: User }> }, _args: unknown, context: GqlContext) => {
        // If parent already includes relation with nested author, return those authors
          if (parent.userSubscribedTo && parent.userSubscribedTo.length > 0 && parent.userSubscribedTo[0].author) {
            return parent.userSubscribedTo.map((s) => s.author);
          }
        // Otherwise use DataLoader to batch load authors for this subscriber
        if (context.loaders?.subscribers) {
          return context.loaders.subscribers.load(parent.id);
        }
        // Fallback: single query
        const subs = await context.prisma.subscribersOnAuthors.findMany({ where: { subscriberId: parent.id }, include: { author: true } });
        return subs.map((s) => s.author);
      };
    }

    if (subscribedToUserField) {
      subscribedToUserField.resolve = async (parent: { id: string; subscribedToUser?: Array<{ subscriber: User }> }, _args: unknown, context: GqlContext) => {
          if (parent.subscribedToUser && parent.subscribedToUser.length > 0 && parent.subscribedToUser[0].subscriber) {
            return parent.subscribedToUser.map((s) => s.subscriber);
          }
        if (context.loaders?.subscribedTo) {
          return context.loaders.subscribedTo.load(parent.id);
        }
        const subs = await context.prisma.subscribersOnAuthors.findMany({ where: { authorId: parent.id }, include: { subscriber: true } });
        return subs.map((s) => s.subscriber);
      };
    }
  }

  if (profileType) {
    const memberTypeField = profileType.getFields().memberType;
    if (memberTypeField) {
      memberTypeField.resolve = (parent: { memberTypeId: string }, _args: unknown, context: GqlContext) =>
        context.loaders?.memberType ? context.loaders.memberType.load(parent.memberTypeId) : context.prisma.memberType.findUnique({ where: { id: parent.memberTypeId } });
    }
  }

  // Attach resolvers to root query and mutation types
  if (rootQueryType) {
    const fields = rootQueryType.getFields();
    Object.entries(fields).forEach(([fieldName]) => {
      const resolver = rootValue[fieldName as keyof typeof rootValue];
      if (resolver) {
        // Wrap users resolver to provide per-request DataLoaders and parse resolve info
            if (fieldName === 'users') {
              fields[fieldName].resolve = (async (parent: unknown, args: unknown, context: GqlContext, info: GraphQLResolveInfo) => {
            // Create per-request DataLoaders
            const userLoader = new DataLoader<string, User | null>(async (keys) => {
              const ids = Array.from(keys);
              const users = await context.prisma.user.findMany({ where: { id: { in: ids } } });
              const map = new Map(users.map((u) => [u.id, u]));
              return ids.map((id) => (map.get(id) ?? null));
            });

            const postsLoader = new DataLoader<string, Post[]>(async (keys) => {
              const authorIds = Array.from(keys);
              const posts = await context.prisma.post.findMany({ where: { authorId: { in: authorIds } } });
              return authorIds.map((id) => posts.filter((p) => p.authorId === id));
            });

            const memberTypeLoader = new DataLoader<string, MemberType | null>(async (keys) => {
              const ids = Array.from(keys);
              const mts = await context.prisma.memberType.findMany({ where: { id: { in: ids } } });
              const map = new Map(mts.map((m) => [m.id, m]));
              return ids.map((id) => (map.get(id) ?? null));
            });
            const profileLoader = new DataLoader<string, Profile | null>(async (keys) => {
              const userIds = Array.from(keys);
              const profiles = await context.prisma.profile.findMany({ where: { userId: { in: userIds } } });
              const map = new Map(profiles.map((p) => [p.userId, p]));
              return userIds.map((id) => (map.get(id) ?? null));
            });

            const subscribersLoader = new DataLoader<string, User[]>(async (keys) => {
              const subscriberIds = Array.from(keys);
              const subs = await context.prisma.subscribersOnAuthors.findMany({ where: { subscriberId: { in: subscriberIds } }, include: { author: true } });
              const grouped = subscriberIds.map((id) => subs.filter((s) => s.subscriberId === id).map((s) => s.author));
              return grouped;
            });

            const subscribedToLoader = new DataLoader<string, User[]>(async (keys) => {
              const authorIds = Array.from(keys);
              const subs = await context.prisma.subscribersOnAuthors.findMany({ where: { authorId: { in: authorIds } }, include: { subscriber: true } });
              const grouped = authorIds.map((id) => subs.filter((s) => s.authorId === id).map((s) => s.subscriber));
              return grouped;
            });

            // Attach loaders to context for nested resolvers
            context.loaders = { user: userLoader, subscribers: subscribersLoader, subscribedTo: subscribedToLoader, posts: postsLoader, memberType: memberTypeLoader, profile: profileLoader };

            // Use parseResolveInfo to detect if subs relations are requested
            const include: Prisma.UserInclude = {} as Prisma.UserInclude;
            try {
              // Fallback: inspect GraphQLResolveInfo fieldNodes to detect requested sub-fields for 'users'
              const nodes = info.fieldNodes ?? [];
              const selNames = new Set<string>();
              for (const node of nodes) {
                if (node.selectionSet && 'selections' in node.selectionSet) {
                  const selections = (node.selectionSet as unknown as { selections: Array<{ kind: string; name?: { value: string } }> }).selections;
                  if (Array.isArray(selections)) {
                    for (const s of selections) {
                      if (s && typeof s === 'object' && 'kind' in s && s.kind === 'Field' && 'name' in s && s.name && typeof s.name === 'object' && 'value' in s.name) {
                        selNames.add((s.name as { value: string }).value);
                      }
                    }
                  }
                }
              }
              if (selNames.has('userSubscribedTo')) include.userSubscribedTo = true;
              if (selNames.has('subscribedToUser')) include.subscribedToUser = true;
            } catch {
              // ignore parse errors and proceed without includes
            }

            // If includes were detected, perform a single findMany with includes
            if (Object.keys(include).length > 0) {
              const users = await context.prisma.user.findMany({ include });
              // If join relations are present but don't include nested user objects (Prisma returns join rows),
              // attach related User objects from the same users array to avoid extra DB calls and prime loaders.
              // Example: users[i].userSubscribedTo -> array of SubscribersOnAuthors { subscriberId, authorId }
              // We'll attach .author/.subscriber from the returned users (if present) to each join row.
              const usersById = new Map(users.map((u) => [u.id, u]));
              for (const u of users) {
                if (u.userSubscribedTo && Array.isArray(u.userSubscribedTo)) {
                  for (const rel of u.userSubscribedTo) {
                    if (!('author' in rel) || !rel.author) {
                      // @ts-expect-error dynamic attach
                      rel.author = usersById.get(rel.authorId);
                    }
                  }
                }
                if (u.subscribedToUser && Array.isArray(u.subscribedToUser)) {
                  for (const rel of u.subscribedToUser) {
                    if (!('subscriber' in rel) || !rel.subscriber) {
                      // @ts-expect-error dynamic attach
                      rel.subscriber = usersById.get(rel.subscriberId);
                    }
                  }
                }
              }

              // Prime user loader cache
              users.forEach((u) => userLoader.prime(u.id, u));

              // Prime subscribers/subscribedTo loaders using attached join rows (avoid further DB calls)
              if (context.loaders) {
                for (const u of users) {
                  if (u.userSubscribedTo && Array.isArray(u.userSubscribedTo)) {
                    const authors = u.userSubscribedTo.map((rel) => ('author' in rel && rel.author) ? rel.author as User : null).filter(Boolean) as User[];
                    context.loaders.subscribers.prime(u.id, authors);
                  }
                  if (u.subscribedToUser && Array.isArray(u.subscribedToUser)) {
                    const subscribers = u.subscribedToUser.map((rel) => ('subscriber' in rel && rel.subscriber) ? rel.subscriber as User : null).filter(Boolean) as User[];
                    context.loaders.subscribedTo.prime(u.id, subscribers);
                  }
                }
              }

              return users;
            }

            // Default: call original resolver (which can call prisma.user.findMany without includes)
            const result = await (resolver as unknown as GraphQLFieldResolver<unknown, GqlContext, unknown>)(parent, args, context, info);
            // If it's an array of users, prime cache
            if (Array.isArray(result)) {
              result.forEach((u: User) => context.loaders!.user.prime(u.id, u));
            }
            return result;
          }) as GraphQLFieldResolver<unknown, GqlContext, unknown>;
        } else {
          (fields[fieldName].resolve as unknown) = resolver as unknown as GraphQLFieldResolver<unknown, GqlContext, unknown>;
        }
      }
    });
  }

  if (mutationsType) {
    const fields = mutationsType.getFields();
    Object.entries(fields).forEach(([fieldName]) => {
      const resolver = rootValue[fieldName as keyof typeof rootValue];
      if (resolver) {
        (fields[fieldName].resolve as typeof resolver) = resolver;
      }
    });
  }

  fastify.route({
    url: '/',
    method: 'POST',
    schema: {
      ...createGqlResponseSchema,
      response: {
        200: gqlResponseSchema,
      },
    },
    async handler(req) {
      const { query, variables } = (req.body as { query: string; variables?: Record<string, unknown> });
      const context: GqlContext = { prisma: fastify.prisma };

      const documentAST = parse(query);
      const validationErrors = validate(schema, documentAST, [depthLimit(5)]);

      if (validationErrors.length > 0) {
        return { errors: validationErrors };
      }

      const result: ExecutionResult = await graphql({
        schema,
        source: query,
        variableValues: variables,
        contextValue: context,
      });
      // Normalize: remove empty errors array if present
      if (Array.isArray(result.errors) && result.errors.length === 0) {
        result.errors = undefined;
      }
      return result;
    },
  });
};

export default plugin;
