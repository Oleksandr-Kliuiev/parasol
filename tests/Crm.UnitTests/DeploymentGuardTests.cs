using Crm.Integrations.PowerOffice;

namespace Crm.UnitTests;

/// <summary>Production never talks to PowerOffice Demo, test never to Production (DEV-05-AC05).</summary>
public class DeploymentGuardTests
{
    [Theory]
    [InlineData("prod", PowerOfficeEnvironment.Production, true)]
    [InlineData("prod", PowerOfficeEnvironment.Demo, false)]
    [InlineData("test", PowerOfficeEnvironment.Demo, true)]
    [InlineData("test", PowerOfficeEnvironment.Production, false)]
    [InlineData("staging", PowerOfficeEnvironment.Demo, false)]
    [InlineData(null, PowerOfficeEnvironment.Demo, true)]
    [InlineData("", PowerOfficeEnvironment.Production, true)]
    public void PowerOffice_environment_must_fit_the_deployment(string? deployment, PowerOfficeEnvironment environment, bool fits) =>
        PowerOfficeOptions.FitsDeployment(new PowerOfficeOptions { Enabled = true, Environment = environment }, deployment).ShouldBe(fits);

    [Fact]
    public void Production_left_on_the_default_is_refused()
    {
        // The default of the options is Demo; a prod deployment that forgets to set Production does not start.
        PowerOfficeOptions.FitsDeployment(new PowerOfficeOptions { Enabled = true }, "prod").ShouldBeFalse();
        PowerOfficeOptions.FitsDeployment(new PowerOfficeOptions { Enabled = false }, "prod").ShouldBeTrue();
    }
}
