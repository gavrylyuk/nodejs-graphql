import { FastifyPluginAsync } from 'fastify';
import { createGqlResponseSchema, gqlResponseSchema } from './schemas.js';
import { graphql, buildSchema, GraphQLSchema, GraphQLObjectType, parse, validate } from 'graphql';
import depthLimit from 'graphql-depth-limit';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = join(fileURLToPath(import.meta.url), '..');

const plugin: FastifyPluginAsync = async (fastify) => {
  const { prisma } = fastify;

  // Load schema from file
  const typeDefs = readFileSync(join(__dirname, '../../../schema.graphql'), 'utf8');
  let schema: GraphQLSchema;

  try {
    schema = buildSchema(typeDefs);
  } catch (error) {
    throw new Error(`Failed to build GraphQL schema: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Type definitions for args and context
  interface GqlContext {
    prisma: typeof prisma;
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
    const profileField = userType.getFields().profile;
    const postsField = userType.getFields().posts;
    const userSubscribedToField = userType.getFields().userSubscribedTo;
    const subscribedToUserField = userType.getFields().subscribedToUser;

    if (profileField) {
      (profileField.resolve as unknown) = (parent: { id: string }, _args: unknown, context: GqlContext) =>
        context.prisma.profile.findUnique({ where: { userId: parent.id } });
    }
    if (postsField) {
      (postsField.resolve as unknown) = (parent: { id: string }, _args: unknown, context: GqlContext) =>
        context.prisma.post.findMany({ where: { authorId: parent.id } });
    }
    if (userSubscribedToField) {
      (userSubscribedToField.resolve as unknown) = (parent: { id: string }, _args: unknown, context: GqlContext) =>
        context.prisma.subscribersOnAuthors
          .findMany({ where: { subscriberId: parent.id }, include: { author: true } })
          .then((subs) => subs.map((s) => s.author));
    }
    if (subscribedToUserField) {
      (subscribedToUserField.resolve as unknown) = (parent: { id: string }, _args: unknown, context: GqlContext) =>
        context.prisma.subscribersOnAuthors
          .findMany({ where: { authorId: parent.id }, include: { subscriber: true } })
          .then((subs) => subs.map((s) => s.subscriber));
    }
  }

  if (profileType) {
    const memberTypeField = profileType.getFields().memberType;
    if (memberTypeField) {
      (memberTypeField.resolve as unknown) = (parent: { memberTypeId: string }, _args: unknown, context: GqlContext) =>
        context.prisma.memberType.findUnique({ where: { id: parent.memberTypeId } });
    }
  }

  // Attach resolvers to root query and mutation types
  if (rootQueryType) {
    const fields = rootQueryType.getFields();
    Object.entries(fields).forEach(([fieldName]) => {
      const resolver = rootValue[fieldName as keyof typeof rootValue];
      if (resolver) {
        (fields[fieldName].resolve as typeof resolver) = resolver;
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

      const result = await graphql({
        schema,
        source: query,
        variableValues: variables,
        contextValue: context,
      });
      return result;
    },
  });
};

export default plugin;
