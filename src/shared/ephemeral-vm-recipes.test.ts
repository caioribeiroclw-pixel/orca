import { describe, expect, it } from 'vitest'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from './pairing'
import {
  getEphemeralVmRecipeResultWarnings,
  parseEphemeralVmRecipeResult,
  redactEphemeralVmRecipeDiagnosticText,
  redactEphemeralVmRecipeResultForDiagnostics
} from './ephemeral-vm-recipes'

function makePairingCode(endpoint = 'wss://sandbox.example.com'): string {
  return encodePairingOffer({
    v: PAIRING_OFFER_VERSION,
    endpoint,
    deviceToken: 'token',
    publicKeyB64: 'public-key'
  })
}

describe('parseEphemeralVmRecipeResult', () => {
  it('parses the minimum recipe result', () => {
    const result = parseEphemeralVmRecipeResult(
      JSON.stringify({
        schemaVersion: 1,
        pairingCode: makePairingCode(),
        projectRoot: '/workspace/repo'
      })
    )

    expect(result).toEqual({
      ok: true,
      result: {
        schemaVersion: 1,
        pairingCode: makePairingCode(),
        projectRoot: '/workspace/repo'
      }
    })
  })

  it('keeps opaque userData intact', () => {
    const result = parseEphemeralVmRecipeResult(
      JSON.stringify({
        schemaVersion: 1,
        pairingCode: makePairingCode(),
        projectRoot: '/workspace/repo',
        userData: {
          providerResourceId: 'sandbox-123',
          nested: { region: 'us-east-1' }
        }
      })
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.result.userData).toEqual({
        providerResourceId: 'sandbox-123',
        nested: { region: 'us-east-1' }
      })
    }
  })

  it('rejects non-json stdout', () => {
    expect(parseEphemeralVmRecipeResult('Pairing URL: nope')).toEqual({
      ok: false,
      error: 'Recipe stdout must be one JSON object.'
    })
  })

  it('rejects invalid pairing codes', () => {
    expect(
      parseEphemeralVmRecipeResult(
        JSON.stringify({
          schemaVersion: 1,
          pairingCode: 'https://sandbox.example.com/pair',
          projectRoot: '/workspace/repo'
        })
      )
    ).toEqual({
      ok: false,
      error: 'Recipe result pairingCode is not a valid Orca pairing code.'
    })
  })

  it('rejects relative project roots', () => {
    expect(
      parseEphemeralVmRecipeResult(
        JSON.stringify({
          schemaVersion: 1,
          pairingCode: makePairingCode(),
          projectRoot: 'workspace/repo'
        })
      )
    ).toEqual({
      ok: false,
      error: 'Recipe result projectRoot must be an absolute runtime path.'
    })
  })

  it('warns for public insecure websocket endpoints', () => {
    expect(
      getEphemeralVmRecipeResultWarnings({
        schemaVersion: 1,
        pairingCode: makePairingCode('ws://sandbox.example.com:6767'),
        projectRoot: '/workspace/repo'
      })
    ).toEqual([
      expect.objectContaining({
        id: 'recipe.result.endpoint.public_ws',
        message: expect.stringContaining('ws://sandbox.example.com:6767')
      })
    ])
    expect(
      getEphemeralVmRecipeResultWarnings({
        schemaVersion: 1,
        pairingCode: makePairingCode('ws://127.0.0.1:6767'),
        projectRoot: '/workspace/repo'
      })
    ).toEqual([])
    expect(
      getEphemeralVmRecipeResultWarnings({
        schemaVersion: 1,
        pairingCode: makePairingCode('wss://sandbox.example.com'),
        projectRoot: '/workspace/repo'
      })
    ).toEqual([])
  })

  it('redacts pairing material and secret-looking fields in diagnostics', () => {
    const pairingCode = makePairingCode()

    expect(
      redactEphemeralVmRecipeDiagnosticText(
        JSON.stringify({ pairingCode, token: 'provider-token', ok: true })
      )
    ).toBe('{"pairingCode":"[redacted]","token":"[redacted]","ok":true}')
    expect(
      redactEphemeralVmRecipeResultForDiagnostics({
        schemaVersion: 1,
        pairingCode,
        projectRoot: '/workspace/repo',
        userData: {
          providerResourceId: 'sandbox-123',
          accessToken: 'provider-token',
          nested: { apiKey: 'key', region: 'us-east-1' }
        }
      })
    ).toEqual({
      schemaVersion: 1,
      pairingCode: 'orca://pair?code=[redacted]',
      projectRoot: '/workspace/repo',
      userData: {
        providerResourceId: 'sandbox-123',
        accessToken: '[redacted]',
        nested: { apiKey: '[redacted]', region: 'us-east-1' }
      }
    })
  })
})
