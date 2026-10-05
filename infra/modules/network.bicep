param location string
param name string
param tags object

var privateDnsZoneNames = [
  'privatelink${environment().suffixes.sqlServerHostname}'
  'privatelink.vaultcore.azure.net'
  'privatelink.blob.${environment().suffixes.storage}'
]

// Static egress IP for allow-lists at external systems (docs/03-architecture.md §11).
resource natIp 'Microsoft.Network/publicIPAddresses@2024-05-01' = {
  name: 'pip-nat-${name}'
  location: location
  tags: tags
  sku: { name: 'Standard' }
  properties: { publicIPAllocationMethod: 'Static' }
}

resource nat 'Microsoft.Network/natGateways@2024-05-01' = {
  name: 'ng-${name}'
  location: location
  tags: tags
  sku: { name: 'Standard' }
  properties: {
    publicIpAddresses: [{ id: natIp.id }]
    idleTimeoutInMinutes: 10
  }
}

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: 'vnet-${name}'
  location: location
  tags: tags
  properties: {
    addressSpace: { addressPrefixes: ['10.40.0.0/16'] }
    subnets: [
      {
        name: 'snet-apps'
        properties: {
          addressPrefix: '10.40.0.0/23'
          natGateway: { id: nat.id }
          delegations: [
            {
              name: 'containerapps'
              properties: { serviceName: 'Microsoft.App/environments' }
            }
          ]
        }
      }
      {
        name: 'snet-private-endpoints'
        properties: {
          addressPrefix: '10.40.2.0/24'
          privateEndpointNetworkPolicies: 'Disabled'
        }
      }
    ]
  }
}

resource zones 'Microsoft.Network/privateDnsZones@2024-06-01' = [for zone in privateDnsZoneNames: {
  name: zone
  location: 'global'
  tags: tags
}]

resource zoneLinks 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = [for (zone, i) in privateDnsZoneNames: {
  parent: zones[i]
  name: 'link-${name}'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: { id: vnet.id }
  }
}]

output appsSubnetId string = vnet.properties.subnets[0].id
output appsSubnetPrefix string = vnet.properties.subnets[0].properties.addressPrefix
output privateEndpointSubnetId string = vnet.properties.subnets[1].id
output privateDnsZoneIds object = {
  sql: zones[0].id
  keyVault: zones[1].id
  blob: zones[2].id
}
output natPublicIp string = natIp.properties.ipAddress
