import type { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { PostHog } from 'posthog-node';
import { DbAuthHandler } from '@redwoodjs/auth-dbauth-api';
import type {
  DbAuthHandlerOptions,
  UserType,
} from '@redwoodjs/auth-dbauth-api';

import { cookieName } from 'src/lib/auth';
import { db } from 'src/lib/db';
import { generateAPIKey } from 'src/lib/utils';
import {
  createSubscription,
  // getSubscriptionCheckoutUrl,
} from 'src/services/subscriptions/subscriptions';
import { sendResetEmail, sendWelcomeEmail } from 'src/services/emails';

interface UserAttributes {
  name: string;
  plan?: string;
}

const phDefaultClient = new PostHog(process.env.POSTHOG_API_KEY, {
  host: 'https://us.posthog.com',
});

export const handler = async (
  event: APIGatewayProxyEvent,
  context: Context
) => {
  const forgotPasswordOptions: DbAuthHandlerOptions['forgotPassword'] = {
    handler: (user, resetToken) => {
      const url =
        process.env.NODE_ENV === 'development'
          ? 'http://localhost:8910'
          : 'https://shepherdpro.com';
      sendResetEmail({
        input: {
          to: user.email,
          subject: 'Reset your password',
          resetLink: `${url}/reset-password?resetToken=${resetToken}`,
        },
      });

      return user;
    },

    // How long the resetToken is valid for, in seconds (default is 24 hours)
    expires: 60 * 60 * 24,

    errors: {
      // for security reasons you may want to be vague here rather than expose
      // the fact that the email address wasn't found (prevents fishing for
      // valid email addresses)
      usernameNotFound: 'Username not found',
      // if the user somehow gets around client validation
      usernameRequired: 'Username is required',
    },
  };

  const loginOptions: DbAuthHandlerOptions['login'] = {
    // handler() is called after finding the user that matches the
    // username/password provided at login, but before actually considering them
    // logged in. The `user` argument will be the user in the database that
    // matched the username/password.
    //
    // If you want to allow this user to log in simply return the user.
    //
    // If you want to prevent someone logging in for another reason (maybe they
    // didn't validate their email yet), throw an error and it will be returned
    // by the `logIn()` function from `useAuth()` in the form of:
    // `{ message: 'Error message' }`
    handler: (user) => {
      return user;
    },

    errors: {
      usernameOrPasswordMissing: 'Both username and password are required',
      usernameNotFound: 'Username ${username} not found',
      // For security reasons you may want to make this the same as the
      // usernameNotFound error so that a malicious user can't use the error
      // to narrow down if it's the username or password that's incorrect
      incorrectPassword: 'Incorrect password for ${username}',
    },

    // How long a user will remain logged in, in seconds
    expires: 60 * 60 * 24 * 365 * 10,
  };

  const resetPasswordOptions: DbAuthHandlerOptions['resetPassword'] = {
    // handler() is invoked after the password has been successfully updated in
    // the database. Returning anything truthy will automatically logs the user
    // in. Return `false` otherwise, and in the Reset Password page redirect the
    // user to the login page.
    handler: (_user) => {
      return true;
    },

    // If `false` then the new password MUST be different than the current one
    allowReusedPassword: true,

    errors: {
      // the resetToken is valid, but expired
      resetTokenExpired: 'resetToken is expired',
      // no user was found with the given resetToken
      resetTokenInvalid: 'resetToken is invalid',
      // the resetToken was not present in the URL
      resetTokenRequired: 'resetToken is required',
      // new password is the same as the old password (apparently they did not forget it)
      reusedPassword: 'Must choose a new password',
    },
  };

  const signupOptions: DbAuthHandlerOptions<
    UserType,
    UserAttributes
  >['signup'] = {
    // Whatever you want to happen to your data on new user signup. Redwood will
    // check for duplicate usernames before calling this handler. At a minimum
    // you need to save the `username`, `hashedPassword` and `salt` to your
    // user table. `userAttributes` contains any additional object members that
    // were included in the object given to the `signUp()` function you got
    // from `useAuth()`.
    //
    // If you want the user to be immediately logged in, return the user that
    // was created.
    //
    // If this handler throws an error, it will be returned by the `signUp()`
    // function in the form of: `{ error: 'Error message' }`.
    //
    // If this returns anything else, it will be returned by the
    // `signUp()` function in the form of: `{ message: 'String here' }`.
    handler: async ({ username, hashedPassword, salt, userAttributes }) => {
      const newAccount = await db.account.create({
        data: {
          apiKey: generateAPIKey(32),
        },
      });

      const newUser = await db.user.create({
        data: {
          email: username,
          hashedPassword: hashedPassword,
          salt: salt,
          name: userAttributes?.name,
          type: 'OWNER',
          accountId: newAccount.id,
        },
      });

      // Chargebee plan ID for test site defaulted to caps and can't be edited
      const userPlan =
        process.env.NODE_ENV === 'development'
          ? 'Alpha-USD-Monthly'
          : 'alpha-usd-monthly';

      if (newUser) {
        sendWelcomeEmail({
          input: {
            to: username,
            subject: 'Welcome to Shepherd Pro',
          },
        });

        createSubscription({
          input: {
            status: 'IN_TRIAL',
            type: userPlan,
            userId: newUser.id,
          },
        });

        phDefaultClient.capture({
          distinctId: `shepherd-user-${newUser.id}`,
          event: `Shepherd Signup`,
          properties: {
            $set: {
              email: username,
              name: userAttributes?.name,
              plan: userPlan,
            },
          },
          groups: {
            account: newAccount.id,
          },
        });

        // TODO: Uncomment this when we are ready to start charging users
        // const { url } = await getSubscriptionCheckoutUrl({
        //   planId: userPlan,
        // });

        // if (url) {
        //   return url;
        // }

        return newUser;
      }
    },

    // Include any format checks for password here. Return `true` if the
    // password is valid, otherwise throw a `PasswordValidationError`.
    // Import the error along with `DbAuthHandler` from `@redwoodjs/api` above.
    passwordValidation: (_password) => {
      return true;
    },

    errors: {
      // `field` will be either "username" or "password"
      fieldMissing: '${field} is required',
      usernameTaken: 'Username `${username}` already in use',
    },
  };

  const authHandler = new DbAuthHandler(event, context, {
    // Provide prisma db client
    db: db,
    allowedUserFields: ['id', 'email'],

    // The name of the property you'd call on `db` to access your user table.
    // ie. if your Prisma model is named `User` this value would be `user`, as in `db.user`
    authModelAccessor: 'user',

    // The name of the property you'd call on `db` to access your user credentials table.
    // ie. if your Prisma model is named `UserCredential` this value would be `userCredential`, as in `db.userCredential`
    credentialModelAccessor: 'userCredential',

    // A map of what dbAuth calls a field to what your database calls it.
    // `id` is whatever column you use to uniquely identify a user (probably
    // something like `id` or `userId` or even `email`)
    authFields: {
      id: 'id',
      username: 'email',
      hashedPassword: 'hashedPassword',
      salt: 'salt',
      resetToken: 'resetToken',
      resetTokenExpiresAt: 'resetTokenExpiresAt',
      // challenge: 'webAuthnChallenge',
    },

    // Specifies attributes on the cookie that dbAuth sets in order to remember
    // who is logged in. See https://developer.mozilla.org/en-US/docs/Web/HTTP/Cookies#restrict_access_to_cookies
    cookie: {
      attributes: {
        HttpOnly: true,
        Path: '/',
        SameSite: 'Strict',
        Secure: process.env.NODE_ENV !== 'development' ? true : false,

        // If you need to allow other domains (besides the api side) access to
        // the dbAuth session cookie:
        // Domain: 'example.com',
      },
      name: cookieName,
    },

    forgotPassword: forgotPasswordOptions,
    login: loginOptions,
    resetPassword: resetPasswordOptions,
    signup: signupOptions,

    // See https://redwoodjs.com/docs/authentication/dbauth#webauthn for options
    webAuthn: {
      enabled: false,
      // How long to allow re-auth via WebAuthn in seconds (default is 10 years).
      // The `login.expires` time denotes how many seconds before a user will be
      // logged out, and this value is how long they'll be to continue to use a
      // fingerprint/face scan to log in again. When this one expires they
      // *must* re-enter username and password to authenticate (WebAuthn will
      // then be re-enabled for this amount of time).
      expires: 60 * 60 * 24 * 365 * 10,
      name: 'Shepherd Application',
      domain:
        process.env.NODE_ENV === 'development'
          ? 'localhost'
          : 'shepherdpro.com',
      origin:
        process.env.NODE_ENV === 'development'
          ? 'http://localhost:8910'
          : 'https://shepherdpro.com',
      type: 'platform',
      timeout: 60000,
      credentialFields: {
        id: 'id',
        userId: 'userId',
        publicKey: 'publicKey',
        transports: 'transports',
        counter: 'counter',
      },
    },
  });

  return await authHandler.invoke();
};
